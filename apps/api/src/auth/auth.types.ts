export type LoginAttempt = {
  state: string;
  verifier: string;
  expiresAt: number;
};

export type AppSession = {
  userId: number;
  externalSubject: string;
  displayName: string;
  expiresAt: number;
};

export type MockCode = {
  subject: string;
  displayName: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
};
