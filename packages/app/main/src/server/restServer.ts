//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.
//
// Microsoft Bot Framework: http://botframework.com
//
// Bot Framework Emulator Github:
// https://github.com/Microsoft/BotFramwork-Emulator
//
// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License:
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

import {
  LogService,
  LogLevel,
  CommandServiceImpl,
  CommandServiceInstance,
  textItem,
  Logger,
  networkRequestItem,
  networkResponseItem,
} from '@bfemulator/sdk-shared';
import { createServer, plugins, Server, Response, Route } from 'restify';
import CORS from 'restify-cors-middleware';
import { newNotification, SharedConstants } from '@bfemulator/app-shared';
import { IEndpointService } from 'botframework-config/lib/schema';

import { Emulator } from '../emulator';

import { mountAllRoutes } from './routes/mountAllRoutes';
import { ServerState } from './state/serverState';
import { LoggerAdapter } from './state/loggerAdapter';
import { ConsoleLogService } from './state/consoleLogService';
import { stripEmptyBearerTokenMiddleware } from './routes/handlers/stripEmptyBearerToken';
import { Conversation } from './state/conversation';
import { ConversationSet } from './state/conversationSet';

export interface EmulatorRestServerOptions {
  fetch?: (url: string, options?: any) => Promise<any>;
  getServiceUrl?: (botUrl: string) => Promise<string>;
  getServiceUrlForOAuth?: () => Promise<string>;
  logService?: LogService;
  shutDownOAuthNgrokInstance?: () => void;
}

export const defaultRestServerOptions: EmulatorRestServerOptions = {
  fetch: undefined,
  getServiceUrl: () =>
    new Promise((_, reject) =>
      reject(
        new Error(
          'getServiceUrl() has not been configured. Please configure this function by passing it into the EmulatorRestServer constructor via the "options" object.'
        )
      )
    ),
  getServiceUrlForOAuth: () =>
    new Promise((_, reject) =>
      reject(
        new Error(
          'getServiceUrlForOAuth() has not been configured. Please configure this function by passing it into the EmulatorRestServer constructor via the "options" object.'
        )
      )
    ),
  logService: new ConsoleLogService(),
  shutDownOAuthNgrokInstance: () =>
    new Error(
      'shutdownOAuthNgrokInstance() has not been configured. Please configure this function by passing it into the EmulatorRestServer constructor via the "options" object.'
    ),
};

interface ConversationAwareRequest extends Request {
  conversation?: { conversationId?: string };
  params?: { conversationId?: string };
}

const cors = CORS({
  origins: ['*'],
  allowHeaders: [
    'authorization',
    'x-requested-with',
    'x-ms-bot-agent',
    'x-emulator-appid',
    'x-emulator-apppassword',
    'x-emulator-botendpoint',
    'x-emulator-channelservice',
  ],
  exposeHeaders: [],
});

let server;
export class EmulatorRestServer {
  @CommandServiceInstance()
  private commandService: CommandServiceImpl;
  private _serverPort: number;
  private _serverUrl: string;
  public getServiceUrl: (botUrl: string) => Promise<string>;
  public getServiceUrlForOAuth: () => Promise<string>;
  public logger: Logger;
  public options: EmulatorRestServerOptions;
  public server: Server;
  public shutDownOAuthNgrokInstance: () => void;
  public state: ServerState;

  public get serverPort(): number {
    return this._serverPort;
  }

  public get serverUrl(): string {
    return this._serverUrl;
  }

  constructor(options: EmulatorRestServerOptions) {
    // singleton
    if (server) {
      return server;
    }
    this.options = {
      ...defaultRestServerOptions,
      ...options,
    };
    this.logger = new LoggerAdapter(this.options.logService);
    this.state = new ServerState(this.options.fetch);
    this.state.conversations.on('new', this.onNewConversation);
    this.getServiceUrl = this.options.getServiceUrl;
    this.getServiceUrlForOAuth = this.options.getServiceUrlForOAuth;
    this.shutDownOAuthNgrokInstance = this.options.shutDownOAuthNgrokInstance;
    return (server = this);
  }

  public async start(port?: number): Promise<void> {
    if (this.server) {
      this.server.close();
    }
    try {
      await this.createServer();
      // start listening
      const actualPort = await new Promise<number>((resolve, reject) => {
        this.server.once('error', err => reject(err));
        this.server.listen(port, () => {
          resolve(this.server.address().port);
        });
      });
      mountAllRoutes(this);
      this._serverPort = actualPort;
      this._serverUrl = this.server.url;
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        // eslint-disable-next-line
        console.error('Address already in use: ', e);

        const notification = newNotification(
          `Port ${port} is in use and the Emulator cannot start. Please free this port so the emulator can use it.`
        );
        await this.commandService.remoteCall(SharedConstants.Commands.Notifications.Add, notification);
      }
    }
  }

  public close(): Promise<void> {
    return new Promise(resolve => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }

  public report(conversationId: string): void {
    this.options.logService.logToChat(
      conversationId,
      textItem(LogLevel.Debug, `Emulator listening on ${this.serverUrl}`)
    );
  }

  private async createServer(): Promise<void> {
    const server = createServer({ name: 'Emulator' });
    server.on('after', this.onAfterRequest);
    server.pre(cors.preflight);
    server.use([
      cors.actual,
      plugins.acceptParser(server.acceptable),
      stripEmptyBearerTokenMiddleware, // keep an eye on this; this and below handlers were only being used on some routes
      plugins.dateParser(),
      plugins.queryParser(),
    ]);
    this.server = server;
  }

  private onAfterRequest = (req: Request, res: Response, route: Route, err): void => {
    const conversationId = getConversationId(req as ConversationAwareRequest); // route.spec.path: '/api/userToken/getUserData
    if (!shouldPostToChat(conversationId, req.method, route, req as any)) {
      return;
    }

    let level = LogLevel.Debug;
    if (!/2\d\d/.test(res.statusCode.toString())) {
      level = LogLevel.Error;
    }

    // /api/conversation/activities => [api, conversation, activities]
    const routeSegments = ((route.spec.path as string) || '').split('/').filter(segment => !!segment);

    this.options.logService.logToChat(
      conversationId,
      networkRequestItem(
        routeSegments[1] || 'N/A' /* TODO: something else here instea of N/A? */,
        (req as any)._body,
        req.headers,
        req.method,
        req.url
      ),
      networkResponseItem((res as any)._data, res.headers, res.statusCode, res.statusMessage, req.url),
      textItem(level, routeSegments.slice(1).join('.'))
    );
  };

  private onNewConversation = async (conversation: Conversation = {} as Conversation) => {
    const { conversationId = '' } = conversation;
    if (!conversationId || conversationId.includes('transcript')) {
      return;
    }
    // Check for an existing livechat window
    // before creating a new one since "new"
    // can also mean "restart".
    const {
      botEndpoint: { id, botUrl },
      mode,
    } = conversation;

    await this.commandService.remoteCall(
      SharedConstants.Commands.Emulator.NewLiveChat,
      {
        id,
        endpoint: botUrl,
      } as IEndpointService,
      // replace this with some other logic that doesn't use this.botEmulator
      hasLiveChat(conversationId, this.state.conversations),
      conversationId,
      mode
    );
    this.report(conversationId);
    Emulator.getInstance().ngrok.report(conversationId, botUrl);
  };
}

function shouldPostToChat(
  conversationId: string,
  method: string,
  route: Route,
  req: { body: {}; conversation: Conversation }
): boolean {
  const isDLine = method === 'GET' && route.spec.path === '/v3/directline/conversations/:conversationId/activities';
  const isNotTranscript = !!conversationId && !conversationId.includes('transcript');
  const { conversation } = req;
  return !isDLine && isNotTranscript && conversation && conversation.mode !== 'debug';
}

function getConversationId(req: ConversationAwareRequest): string {
  return req.conversation ? req.conversation.conversationId : req.params.conversationId;
}

function hasLiveChat(conversationId: string, conversationSet: ConversationSet): boolean {
  if (conversationId.endsWith('|livechat')) {
    return !!conversationSet.conversationById(conversationId);
  }
  return !!conversationSet.conversationById(conversationId + '|livechat');
}
