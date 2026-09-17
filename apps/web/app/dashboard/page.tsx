import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

type Session = {
  userId: number;
  externalSubject: string;
  displayName: string;
  expiresAt: number;
};

export default async function Dashboard() {
  const cookieHeader = (await cookies())
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const apiUrl =
    process.env.API_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:3001';
  const response = await fetch(`${apiUrl}/auth/session`, {
    headers: { cookie: cookieHeader },
    cache: 'no-store',
  }).catch(() => null);
  if (!response?.ok) redirect('/');
  const session = (await response.json()) as Session;
  return (
    <main className="mx-auto max-w-2xl p-10">
      <p className="mb-4 text-sm tracking-widest text-blue-600 uppercase">
        Protected app page
      </p>
      <h1 className="mb-4 text-3xl font-bold">
        Welcome, {session.displayName}
      </h1>
      <p className="mb-6">
        The mock provider proved identity. This page reads only your app&apos;s
        encrypted HttpOnly session cookie.
      </p>
      <div className="rounded-xl border p-5">
        <p>
          <strong>Database user ID:</strong> {session.userId}
        </p>
        <p>
          <strong>External subject:</strong> {session.externalSubject}
        </p>
        <p>
          <strong>Session expires:</strong>{' '}
          {new Date(session.expiresAt).toLocaleString()}
        </p>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <form action={`${apiUrl}/auth/logout`} method="post">
          <button className="rounded-lg bg-slate-900 px-5 py-3 text-white">
            Log out this session
          </button>
        </form>
        <form action={`${apiUrl}/auth/logout-all`} method="post">
          <button className="rounded-lg border border-red-600 px-5 py-3 text-red-700">
            Log out all devices
          </button>
        </form>
      </div>
    </main>
  );
}
