import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';

const cookieOptions = 'HttpOnly; SameSite=Lax; Path=/';
const secure = () => (process.env.NODE_ENV === 'production' ? '; Secure' : '');
const readCookie = (request: Request, name: string) =>
  request.headers.cookie
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private apiUrl(request: Request) {
    return (
      process.env.API_PUBLIC_URL ||
      `${request.protocol}://${request.get('host')}`
    );
  }

  @Get('auth/login')
  login(@Req() request: Request, @Res() response: Response) {
    const login = this.auth.createLogin(this.apiUrl(request));
    response.setHeader(
      'Set-Cookie',
      `oauth_attempt=${login.cookie}; Max-Age=300; ${cookieOptions}${secure()}`,
    );
    return response.redirect(login.authorizeUrl);
  }

  @Get('mock-provider/authorize')
  authorize(@Req() request: Request, @Res() response: Response) {
    const params = new URLSearchParams(
      Object.entries(request.query).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    );
    const result = this.auth.createMockCode(params, this.apiUrl(request));
    if (!result) {
      return response.status(400).send('Invalid authorization request');
    }
    const callback = new URL(`${this.apiUrl(request)}/auth/callback`);
    callback.searchParams.set('code', result.code);
    callback.searchParams.set('state', result.state);
    return response.redirect(callback.toString());
  }

  @Post('mock-provider/token')
  token(
    @Body()
    body: { code?: string; codeVerifier?: string; redirectUri?: string },
    @Res() response: Response,
  ) {
    const identity =
      body.code && body.codeVerifier && body.redirectUri
        ? this.auth.exchangeMockCode(
            body.code,
            body.codeVerifier,
            body.redirectUri,
          )
        : null;
    return identity
      ? response.json(identity)
      : response.status(400).json({ error: 'invalid_grant' });
  }

  @Get('auth/callback')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Query('state') state?: string,
    @Query('code') code?: string,
  ) {
    const apiUrl = this.apiUrl(request);
    const attempt = state
      ? this.auth.validateAttempt(readCookie(request, 'oauth_attempt'), state)
      : null;
    const tokenResponse =
      attempt && code
        ? await fetch(`${apiUrl}/mock-provider/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              code,
              codeVerifier: attempt.verifier,
              redirectUri: `${apiUrl}/auth/callback`,
            }),
          }).catch(() => null)
        : null;
    const identity = tokenResponse?.ok
      ? ((await tokenResponse.json()) as {
          subject: string;
          displayName: string;
        })
      : null;
    const session = identity ? await this.auth.createSession(identity) : null;
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    response.setHeader(
      'Set-Cookie',
      session
        ? [
            `oauth_attempt=; Max-Age=0; ${cookieOptions}${secure()}`,
            `app_session=${session}; Max-Age=3600; ${cookieOptions}${secure()}`,
          ]
        : `oauth_attempt=; Max-Age=0; ${cookieOptions}${secure()}`,
    );
    return response.redirect(
      session ? `${webUrl}/dashboard` : `${webUrl}/?error=login_failed`,
    );
  }

  @Get('auth/session')
  async session(@Req() request: Request, @Res() response: Response) {
    const session = await this.auth.readSession(
      readCookie(request, 'app_session'),
    );
    return session
      ? response.json(session)
      : response.status(401).json({ error: 'unauthenticated' });
  }

  @Post('auth/logout')
  async logout(@Req() request: Request, @Res() response: Response) {
    await this.auth.revokeCurrentSession(readCookie(request, 'app_session'));
    response.setHeader(
      'Set-Cookie',
      `app_session=; Max-Age=0; ${cookieOptions}${secure()}`,
    );
    return response.redirect(
      303,
      process.env.WEB_URL || 'http://localhost:3000',
    );
  }

  @Post('auth/logout-all')
  async logoutAll(@Req() request: Request, @Res() response: Response) {
    await this.auth.revokeAllSessions(readCookie(request, 'app_session'));
    response.setHeader(
      'Set-Cookie',
      `app_session=; Max-Age=0; ${cookieOptions}${secure()}`,
    );
    return response.redirect(
      303,
      process.env.WEB_URL || 'http://localhost:3000',
    );
  }
}
