import React, { createContext, useContext, useState, useEffect } from 'react';

export interface User {
  email: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  requestReset: (email: string) => Promise<void>;
  resetPassword: (email: string, code: string, pass: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedUser = localStorage.getItem('sao_auth_user');
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch (e) {
        localStorage.removeItem('sao_auth_user');
      }
    }
    setLoading(false);
  }, []);

  const login = async (email: string, _password: string) => {
    // Mimic API request and authenticate
    const loggedUser = { email, name: email.split('@')[0].toUpperCase() };
    localStorage.setItem('sao_auth_user', JSON.stringify(loggedUser));
    setUser(loggedUser);
  };

  const register = async (name: string, email: string, _password: string) => {
    const registeredUser = { email, name };
    localStorage.setItem('sao_auth_user', JSON.stringify(registeredUser));
    setUser(registeredUser);
  };

  const logout = () => {
    localStorage.removeItem('sao_auth_user');
    setUser(null);
  };

  const requestReset = async (_email: string) => {
    // Mimic API request for password reset
    return new Promise<void>((resolve) => setTimeout(resolve, 800));
  };

  const resetPassword = async (_email: string, _code: string, _pass: string) => {
    return new Promise<void>((resolve) => setTimeout(resolve, 800));
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, requestReset, resetPassword }}>
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
