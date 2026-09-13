export type LoginAttempt = {
  state: string;
  verifier: string;
  expiresAt: number;
};
export type Session = {
  sub: string;
  name: string;
  role: 'viewer';
  expiresAt: number;
};
export type MockCode = {
  sub: string;
  name: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
};
