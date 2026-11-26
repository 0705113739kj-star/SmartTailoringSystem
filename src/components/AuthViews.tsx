import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, Phone, Building2, User, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { apiRequest, isMobileNative, setAuthTokens } from '../lib/api';
import type { AuthUser } from '../types';
import { BrandLogo } from './BrandLogo';

interface AuthViewsProps {
  onAuthenticated: (user: AuthUser) => void;
}

export const AuthViews: React.FC<AuthViewsProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Login state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPwd, setShowLoginPwd] = useState(false);

  // Registration state
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [currency, setCurrency] = useState('KES');
  const [regPassword, setRegPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showRegPwd, setShowRegPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);

  // Forgot / Reset password state
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPwd, setShowNewPwd] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const data = await apiRequest<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      setAuthTokens({ csrfToken: data.user.csrfToken, sessionToken: data.user.sessionToken });
      onAuthenticated(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to log in.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (regPassword !== confirmPassword) {
      setError('Password and confirm password do not match.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiRequest<{ user: AuthUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          businessName,
          ownerName,
          email: regEmail,
          phone: regPhone,
          currency,
          password: regPassword,
          confirmPassword,
        }),
      });
      setAuthTokens({ csrfToken: data.user.csrfToken, sessionToken: data.user.sessionToken });
      onAuthenticated(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const data = await apiRequest<{ message: string; devResetCode?: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: forgotEmail }),
      });
      setResetStep('confirm');
      setInfo(
        data.devResetCode
          ? `${data.message} Reset code: ${data.devResetCode}`
          : data.message
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate reset.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const data = await apiRequest<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email: forgotEmail, resetCode, newPassword }),
      });
      setMode('login');
      setLoginEmail(forgotEmail);
      setResetStep('request');
      setResetCode('');
      setNewPassword('');
      setInfo(data.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-12 bg-slate-50">
      {/* Left Brand & Craft Panel */}
      <div className="hidden lg:flex lg:col-span-5 bg-slate-900 text-white flex-col justify-between p-12 relative overflow-hidden">
        <div>
          <BrandLogo dark />
        </div>

        <div className="my-auto max-w-md space-y-6">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-teal-300 tracking-wide">
            <span>Bespoke Workshop Operations</span>
            <span aria-hidden="true">·</span>
            <span>{isMobileNative() ? 'Android Offline Edition' : 'Windows Desktop Edition'}</span>
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-white leading-tight [text-wrap:balance]">
            Precision tailoring operations from measurement to final collection.
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed">
            Manage customer fittings, versioned body measurements, fabric estimations, actual stock consumption, Cash &amp; manual M-Pesa payments, local backups, and true profitability offline on your workshop computer.
          </p>

          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800">
            <div>
              <p className="text-xs text-slate-400">Workshop Data Privacy</p>
              <p className="mt-1 text-sm font-medium text-white">Local SQLite Storage</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Availability</p>
              <p className="mt-1 text-sm font-medium text-white">100% Offline-First</p>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-400">
          SmartTailoringSystem · {isMobileNative() ? 'Offline Android & Desktop Workshop POS' : 'Standalone Desktop Workshop POS'}
        </p>
      </div>

      {/* Right Authentication Form */}
      <div className="lg:col-span-7 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md bg-white rounded-xl border border-slate-200 p-8">
          <div className="lg:hidden mb-6">
            <BrandLogo />
          </div>

          {error && (
            <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              {error}
            </div>
          )}
          {info && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{info}</span>
            </div>
          )}

          {mode === 'login' && (
            <>
              <div className="mb-6">
                <h2 className="font-display text-2xl font-bold text-slate-900">Sign in to your workshop</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Enter your registered business owner credentials to continue.
                </p>
              </div>

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Email address or Username
                  </label>
                  <div className="relative">
                    <Mail className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-email"
                      type="text"
                      required
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      placeholder="owner@atelier.com or username"
                      className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setInfo('');
                        setForgotEmail(loginEmail);
                        setMode('forgot');
                      }}
                      className="text-xs font-medium text-teal-700 hover:text-teal-800 hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <Lock className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-password"
                      type={showLoginPwd ? 'text' : 'password'}
                      required
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Enter your password"
                      className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-10 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPwd((v) => !v)}
                      aria-label={showLoginPwd ? 'Hide password' : 'Show password'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800"
                    >
                      {showLoginPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60 transition-colors"
                >
                  {loading ? 'Signing in...' : 'Login'}
                </button>
              </form>

              <div className="mt-6 pt-6 border-t border-slate-200 text-center">
                <p className="text-sm text-slate-600 mb-3">New tailoring business?</p>
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setInfo('');
                    setMode('register');
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
                >
                  Create Account
                </button>
              </div>
            </>
          )}

          {mode === 'register' && (
            <>
              <div className="mb-5">
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setMode('login');
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 mb-3"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to Login
                </button>
                <h2 className="font-display text-2xl font-bold text-slate-900">Create business account</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Set up an independent workspace for your tailoring business.
                </p>
              </div>

              <form onSubmit={handleRegister} className="space-y-3.5">
                <div>
                  <label htmlFor="reg-business" className="block text-sm font-medium text-slate-700 mb-1">
                    Business name
                  </label>
                  <div className="relative">
                    <Building2 className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="reg-business"
                      type="text"
                      required
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="Savile Craft Tailors"
                      className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="reg-owner" className="block text-sm font-medium text-slate-700 mb-1">
                    Business owner's name
                  </label>
                  <div className="relative">
                    <User className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="reg-owner"
                      type="text"
                      required
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                      placeholder="Grace Mwangi"
                      className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="reg-email" className="block text-sm font-medium text-slate-700 mb-1">
                      Email address
                    </label>
                    <div className="relative">
                      <Mail className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="reg-email"
                        type="email"
                        required
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="owner@shop.com"
                        className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="reg-phone" className="block text-sm font-medium text-slate-700 mb-1">
                      Phone number
                    </label>
                    <div className="relative">
                      <Phone className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="reg-phone"
                        type="tel"
                        required
                        value={regPhone}
                        onChange={(e) => setRegPhone(e.target.value)}
                        placeholder="0712 345 678"
                        className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label htmlFor="reg-currency" className="block text-sm font-medium text-slate-700 mb-1">
                    Operating currency
                  </label>
                  <select
                    id="reg-currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                  >
                    <option value="KES">KES — Kenyan Shilling</option>
                    <option value="USD">USD — US Dollar</option>
                    <option value="GBP">GBP — British Pound</option>
                    <option value="EUR">EUR — Euro</option>
                    <option value="UGX">UGX — Ugandan Shilling</option>
                    <option value="TZS">TZS — Tanzanian Shilling</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="reg-password" className="block text-sm font-medium text-slate-700 mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="reg-password"
                      type={showRegPwd ? 'text' : 'password'}
                      required
                      minLength={6}
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="Minimum 6 characters"
                      className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-10 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowRegPwd((v) => !v)}
                      aria-label={showRegPwd ? 'Hide password' : 'Show password'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800"
                    >
                      {showRegPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="reg-confirm" className="block text-sm font-medium text-slate-700 mb-1">
                    Confirm password
                  </label>
                  <div className="relative">
                    <Lock className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="reg-confirm"
                      type={showConfirmPwd ? 'text' : 'password'}
                      required
                      minLength={6}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-10 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPwd((v) => !v)}
                      aria-label={showConfirmPwd ? 'Hide password' : 'Show password'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800"
                    >
                      {showConfirmPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60 transition-colors"
                >
                  {loading ? 'Creating Business Workspace...' : 'Create Account'}
                </button>
              </form>
            </>
          )}

          {mode === 'forgot' && (
            <>
              <div className="mb-5">
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setInfo('');
                    setMode('login');
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 mb-3"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to Login
                </button>
                <h2 className="font-display text-2xl font-bold text-slate-900">Reset password</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {resetStep === 'request'
                    ? 'Enter your registered email address to request a reset code.'
                    : 'Enter the reset code and choose a new password.'}
                </p>
              </div>

              {resetStep === 'request' ? (
                <form onSubmit={handleForgotRequest} className="space-y-4">
                  <div>
                    <label htmlFor="forgot-email" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Email address
                    </label>
                    <input
                      id="forgot-email"
                      type="email"
                      required
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
                  >
                    {loading ? 'Generating...' : 'Request Reset Code'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleResetConfirm} className="space-y-4">
                  <div>
                    <label htmlFor="reset-code" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Reset code
                    </label>
                    <input
                      id="reset-code"
                      type="text"
                      required
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="reset-new-pwd" className="block text-sm font-medium text-slate-700 mb-1.5">
                      New password
                    </label>
                    <div className="relative">
                      <input
                        id="reset-new-pwd"
                        type={showNewPwd ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3.5 pr-10 py-2.5 text-sm focus:border-teal-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewPwd((v) => !v)}
                        aria-label={showNewPwd ? 'Hide password' : 'Show password'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500"
                      >
                        {showNewPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
                  >
                    {loading ? 'Updating...' : 'Update Password'}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
