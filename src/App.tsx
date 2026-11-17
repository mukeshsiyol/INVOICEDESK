/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditTrailPage } from './pages/AuditTrailPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProcessingWorkspacePage } from './pages/ProcessingWorkspacePage';
import { PurchaseOrdersPage } from './pages/PurchaseOrdersPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UploadPage } from './pages/UploadPage';
import { VendorsPage } from './pages/VendorsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

function AuthenticatedApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-[#0B0F17] flex items-center justify-center text-slate-500">
        <div className="flex items-center gap-2.5 text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
          <span>Loading InvoiceDesk workspace…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/invoices" element={<InvoicesPage />} />
        <Route path="/invoices/:invoiceId" element={<ProcessingWorkspacePage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/reviews" element={<ReviewQueuePage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
        <Route path="/vendors" element={<VendorsPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/audit" element={<AuditTrailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <BrowserRouter>
            <AuthenticatedApp />
          </BrowserRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
