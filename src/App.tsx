/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { Profiler } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { handleProfilerRender } from './lib/renderProfiler';
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
    <Profiler id="CoreWorkspace" onRender={handleProfilerRender}>
      <AppShell>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route
            path="/invoices"
            element={
              <Profiler id="InvoicesLedger" onRender={handleProfilerRender}>
                <InvoicesPage />
              </Profiler>
            }
          />
          <Route
            path="/invoices/:invoiceId"
            element={
              <Profiler id="ProcessingWorkspace" onRender={handleProfilerRender}>
                <ProcessingWorkspacePage />
              </Profiler>
            }
          />
          <Route
            path="/upload"
            element={
              <Profiler id="InvoiceUpload" onRender={handleProfilerRender}>
                <UploadPage />
              </Profiler>
            }
          />
          <Route
            path="/reviews"
            element={
              <Profiler id="ReviewQueue" onRender={handleProfilerRender}>
                <ReviewQueuePage />
              </Profiler>
            }
          />
          <Route
            path="/runs"
            element={
              <Profiler id="PipelineRuns" onRender={handleProfilerRender}>
                <RunsPage />
              </Profiler>
            }
          />
          <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="/vendors" element={<VendorsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/audit" element={<AuditTrailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </Profiler>
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
