import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  challenge,
  equal,
  hashToken,
  open,
  randomSecret,
  seal,
} from './auth.crypto';
import type {
  LoginAttempt,
  MockCode,
  SessionCookie,
  SessionView,
} from './auth.types';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  createLogin(apiUrl: string) {
    const state = randomSecret();
    const verifier = randomSecret();
    const redirectUri = `${apiUrl}/auth/callback`;
    const authorizeUrl = new URL(`${apiUrl}/mock-provider/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: 'demo-app',
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    const attempt: LoginAttempt = {
      state,
      verifier,
      expiresAt: Date.now() + 5 * 60_000,
    };
    return {
      authorizeUrl: authorizeUrl.toString(),
      cookie: seal(attempt, 'login-attempt'),
    };
  }

  createMockCode(params: URLSearchParams, apiUrl: string) {
    const redirectUri = `${apiUrl}/auth/callback`;
    if (
      params.get('client_id') !== 'demo-app' ||
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      params.get('redirect_uri') !== redirectUri ||
      !params.get('state') ||
      !params.get('code_challenge')
    )
      return null;
    const code: MockCode = {
      subject: 'mock-thaid-123',
      displayName: 'Demo ThaiD User',
      codeChallenge: params.get('code_challenge')!,
      redirectUri,
      expiresAt: Date.now() + 60_000,
    };
    return { code: seal(code, 'mock-code'), state: params.get('state')! };
  }

  exchangeMockCode(codeToken: string, verifier: string, redirectUri: string) {
    const code = open<MockCode>(codeToken, 'mock-code');
    if (
      !code ||
      code.expiresAt < Date.now() ||
      code.redirectUri !== redirectUri ||
      !equal(code.codeChallenge, challenge(verifier))
    )
      return null;
    return { subject: code.subject, displayName: code.displayName };
  }

  validateAttempt(attemptToken: string | undefined, state: string) {
    const attempt = open<LoginAttempt>(attemptToken, 'login-attempt');
    if (
      !attempt ||
      attempt.expiresAt < Date.now() ||
      !equal(attempt.state, state)
    )
      return null;
    return attempt;
  }

  async createSession(identity: { subject: string; displayName: string }) {
    const user = await this.prisma.client.appUser.upsert({
      where: { externalSubject: identity.subject },
      update: { displayName: identity.displayName },
      create: {
        externalSubject: identity.subject,
        displayName: identity.displayName,
      },
    });
    const token = randomSecret();
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await this.prisma.client.authSession.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt,
      },
    });
    const session: SessionCookie = {
      token,
      expiresAt: expiresAt.getTime(),
    };
    return seal(session, 'app-session');
  }

  private readSessionCookie(cookie: string | undefined) {
    const session = open<SessionCookie>(cookie, 'app-session');
    return session && session.expiresAt >= Date.now() ? session : null;
  }

  async readSession(cookie: string | undefined): Promise<SessionView | null> {
    const protectedSession = this.readSessionCookie(cookie);
    if (!protectedSession) return null;
    const session = await this.prisma.client.authSession.findUnique({
      where: { tokenHash: hashToken(protectedSession.token) },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() < Date.now()
    ) {
      return null;
    }
    return {
      userId: session.user.id,
      externalSubject: session.user.externalSubject,
      displayName: session.user.displayName,
      expiresAt: session.expiresAt.getTime(),
    };
  }

  async revokeCurrentSession(cookie: string | undefined) {
    const session = this.readSessionCookie(cookie);
    if (!session) return 0;
    const result = await this.prisma.client.authSession.updateMany({
      where: {
        tokenHash: hashToken(session.token),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async revokeAllSessions(cookie: string | undefined) {
    const protectedSession = this.readSessionCookie(cookie);
    if (!protectedSession) return 0;
    const current = await this.prisma.client.authSession.findUnique({
      where: { tokenHash: hashToken(protectedSession.token) },
    });
    if (
      !current ||
      current.revokedAt ||
      current.expiresAt.getTime() < Date.now()
    ) {
      return 0;
    }
    const result = await this.prisma.client.authSession.updateMany({
      where: {
        userId: current.userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
