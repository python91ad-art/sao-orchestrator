import React, { createContext, useContext, useEffect, useState } from 'react';

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  requestReset: (email: string) => Promise<void>;
  resetPassword: (email: string, code: string, pass: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function trpcCall<T>(
  procedure: string,
  input?: unknown,
  method: 'GET' | 'POST' = 'POST'
): Promise<T> {
  const response = await fetch(`/api/trpc/${procedure}`, {
    method,
    credentials: 'include',
    headers:
      method === 'POST'
        ? { 'Content-Type': 'application/json' }
        : undefined,
    body: method === 'POST' ? JSON.stringify(input ?? {}) : undefined,
  });

  const json = await response.json();

  if (!response.ok || json?.error) {
    throw new Error(
      json?.error?.json?.message ||
      json?.error?.message ||
      `Authentication request failed (${response.status})`
    );
  }

  return json?.result?.data as T;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const currentUser = await trpcCall<User>(
          'auth.me',
          undefined,
          'GET'
        );

        if (mounted) {
          setUser(currentUser);
        }
      } catch {
        if (mounted) {
          setUser(null);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const login = async (email: string, password: string) => {
    const result = await trpcCall<{
      success: boolean;
      user: User;
    }>('auth.login', {
      email,
      password,
    });

    setUser(result.user);
  };

  const register = async (
    name: string,
    email: string,
    password: string
  ) => {
    const result = await trpcCall<{
      success: boolean;
      user: User;
    }>('auth.register', {
      email,
      password,
      name,
    });

    setUser(result.user);
  };

  const logout = async () => {
    await trpcCall<{ success: boolean }>('auth.logout', {});
    setUser(null);
  };

  const requestReset = async (email: string) => {
    await trpcCall('auth.forgotPassword', {
      email,
    });
  };

  const resetPassword = async (
    email: string,
    code: string,
    pass: string
  ) => {
    await trpcCall('auth.resetPassword', {
      email,
      code,
      newPassword: pass,
    });
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        logout,
        requestReset,
        resetPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
};
