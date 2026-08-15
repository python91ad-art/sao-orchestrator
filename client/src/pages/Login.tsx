import React, { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

const Login: React.FC = () => {
  const { login, register, requestReset, resetPassword } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [isResetMode, setIsResetMode] = useState(false);
  const [isResetConfirmMode, setIsResetConfirmMode] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      if (isResetConfirmMode) {
        if (!code || !newPassword) throw new Error('Code and New Password are required.');
        await resetPassword(email, code, newPassword);
        setSuccess('Password updated successfully. You can now login.');
        setIsResetConfirmMode(false);
        setIsResetMode(false);
        setIsRegister(false);
      } else if (isResetMode) {
        if (!email) throw new Error('Email is required.');
        await requestReset(email);
        setSuccess('Verification code sent to your email.');
        setIsResetConfirmMode(true);
      } else if (isRegister) {
        if (!name || !email || !password) throw new Error('All fields are required.');
        await register(name, email, password);
      } else {
        if (!email || !password) throw new Error('Email and password are required.');
        await login(email, password);
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during authentication.');
    } finally {
      setLoading(false);
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
            {isResetConfirmMode
              ? 'Enter Reset Code'
              : isResetMode
              ? 'Reset Password'
              : isRegister
              ? 'Create your account'
              : 'Sign in to SAO'}
          </h2>
          <p className="mt-2 text-sm text-neutral-400">
            {isResetConfirmMode
              ? 'Check your inbox for a 6-digit confirmation code'
              : isResetMode
              ? 'We will send you an OTP to reset your password'
              : isRegister
              ? 'Join the Situational Arbitrage Orchestrator'
              : 'Orchestrate asymmetric market opportunities'}
          </p>
        </div>

        <div className="card-bold">
          <form className="space-y-6" onSubmit={handleSubmit}>
            {error && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-400">
                {error}
              </div>
            )}
            {success && (
              <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-3 text-sm text-green-400">
                {success}
              </div>
            )}

            <div className="space-y-4">
              {isRegister && !isResetMode && !isResetConfirmMode && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Enter your name"
                  />
                </div>
              )}

              {!isResetConfirmMode && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                    Email address
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="sao@example.com"
                  />
                </div>
              )}

              {isResetConfirmMode && (
                <>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                      6-Digit Code
                    </label>
                    <input
                      type="text"
                      maxLength={6}
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="123456"
                      className="text-center tracking-widest text-lg font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                      New Password
                    </label>
                    <input
                      type="password"
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                </>
              )}

              {!isResetMode && !isResetConfirmMode && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setIsResetMode(true);
                        setError(null);
                        setSuccess(null);
                      }}
                      className="text-xs font-medium text-purple-400 hover:text-purple-300 transition-colors"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
              )}
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full btn-bold-primary"
              >
                {loading ? (
                  <div className="spinner"></div>
                ) : isResetConfirmMode ? (
                  'Reset Password'
                ) : isResetMode ? (
                  'Send Reset Code'
                ) : isRegister ? (
                  'Sign Up'
                ) : (
                  'Sign In'
                )}
              </button>
            </div>
          </form>

          <div className="mt-6 border-t border-neutral-800 pt-6 text-center">
            {isResetMode || isResetConfirmMode ? (
              <button
                onClick={() => {
                  setIsResetMode(false);
                  setIsResetConfirmMode(false);
                  setError(null);
                  setSuccess(null);
                }}
                className="text-sm font-medium text-neutral-400 hover:text-white transition-colors"
              >
                Back to Login
              </button>
            ) : (
              <button
                onClick={() => {
                  setIsRegister(!isRegister);
                  setError(null);
                  setSuccess(null);
                }}
                className="text-sm font-medium text-purple-400 hover:text-purple-300 transition-colors"
              >
                {isRegister ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
