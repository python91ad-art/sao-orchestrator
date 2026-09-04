import React, { useEffect, useState } from 'react';
import { trpc } from '../lib/trpc';

const Registration: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  const registerMutation = trpc.auth.register.useMutation();

  useEffect(() => {
    const inviteToken = new URLSearchParams(window.location.search).get('invite');

    if (!inviteToken) {
      setTokenError('No invitation token was provided.');
      return;
    }

    setToken(inviteToken);
  }, []);

  const inviteQuery = trpc.auth.validateInvite.useQuery(
    { token: token || '' },
    {
      enabled: !!token,
      retry: false,
    }
  );

  const error =
    tokenError ||
    registrationError ||
    (inviteQuery.error instanceof Error
      ? inviteQuery.error.message
      : inviteQuery.error
        ? 'Unable to validate this invitation.'
        : null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegistrationError(null);

    if (!token || !inviteQuery.data) {
      setRegistrationError('This invitation could not be validated.');
      return;
    }

    if (password !== confirmPassword) {
      setRegistrationError('Passwords do not match.');
      return;
    }

    try {
      await registerMutation.mutateAsync({
        token,
        password,
      });

      window.location.href = '/';
    } catch (error: any) {
      setRegistrationError(
        error?.message || 'Failed to create your account.'
      );
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#100e17] px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-[#a855f7] via-[#f43f5e] to-[#eab308] shadow-lg shadow-purple-500/20">
            <span className="text-2xl font-black text-white">SAO</span>
          </div>

          <h2 className="mt-6 text-3xl font-extrabold tracking-tight text-white">
            Join SAO
          </h2>

          <p className="mt-2 text-sm text-neutral-400">
            Complete your invitation registration
          </p>
        </div>

        <div className="card-bold">
          {inviteQuery.isLoading && (
            <div className="flex justify-center py-8">
              <div className="spinner"></div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-4 text-sm text-red-400">
              {error}
            </div>
          )}

          {inviteQuery.data && !error && (
            <form className="space-y-6" onSubmit={handleSubmit}>
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                  Invitation
                </p>

                <p className="mt-2 text-sm text-neutral-300">
                  You have been invited to join SAO as a{' '}
                  <span className="font-semibold text-white">
                    {inviteQuery.data.role}
                  </span>.
                </p>

                <p className="mt-1 text-sm text-purple-400">
                  {inviteQuery.data.email}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Create password
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  Confirm password
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>

              <button
                type="submit"
                disabled={
                  !password ||
                  !confirmPassword ||
                  registerMutation.isPending
                }
                className="w-full btn-bold-primary"
              >
                {registerMutation.isPending ? 'Creating Account...' : 'Create Account'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default Registration;
