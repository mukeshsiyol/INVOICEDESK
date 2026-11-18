import React, { useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { type UserRole } from '../lib/api';
import { Button, Card, ErrorBanner } from '../components/ui/Primitives';

export function LoginPage() {
  const { login, switchDemoRole } = useAuth();
  const [email, setEmail] = useState('admin@invoicedesk.io');
  const [password, setPassword] = useState('InvoiceDesk2026!');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setLoading(false);
    }
  };

  const quickDemo = async (role: UserRole) => {
    setLoading(true);
    setError(null);
    try {
      await switchDemoRole(role);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start demo session.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B0F17] flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1.5">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-blue-600 text-white font-display font-bold text-lg mb-2">
            ID
          </div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            InvoiceDesk
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Accounts Payable Automation & Decision Verification
          </p>
        </div>

        <Card className="p-6 space-y-5">
          {error && <ErrorBanner message={error} />}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Work Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-9 px-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <Button type="submit" variant="primary" className="w-full" loading={loading}>
              <Lock className="w-3.5 h-3.5" />
              Sign In
            </Button>
          </form>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 mb-2.5">
              <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
              <span>Quick Demo Persona Access</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['OPERATOR', 'REVIEWER', 'AUDITOR', 'ADMIN'] as UserRole[]).map((role) => (
                <Button
                  key={role}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void quickDemo(role)}
                  disabled={loading}
                >
                  {role}
                </Button>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
