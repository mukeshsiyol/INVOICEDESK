import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bell,
  Building2,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  ShoppingCart,
  Sun,
  UserCheck,
  X,
} from 'lucide-react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { apiFetch, formatCurrency, type UserRole } from '../../lib/api';
import { Button, DecisionBadge, Modal } from '../ui/Primitives';

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  roles?: UserRole[];
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout, switchDemoRole } = useAuth();
  const { resolvedTheme, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const { data: notifData } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiFetch<{ items: any[]; unread_count: number }>('/notifications'),
    refetchInterval: 15000,
    enabled: Boolean(user),
  });

  const { data: searchResults } = useQuery({
    queryKey: ['global-search', searchQuery],
    queryFn: () => apiFetch<{ invoices: any[]; purchase_orders: any[]; vendors: any[] }>(`/search?q=${encodeURIComponent(searchQuery)}`),
    enabled: searchOpen && searchQuery.trim().length >= 1,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setNotifOpen(false);
    setProfileOpen(false);
  }, [location.pathname]);

  const pendingReviews = notifData?.items?.filter((n) => n.review_status === 'PENDING_REVIEW').length ?? 0;

  const navGroups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: 'Workspace',
      items: [
        { label: 'Overview', to: '/', icon: LayoutDashboard },
        { label: 'Invoices', to: '/invoices', icon: FileText },
        { label: 'Review Queue', to: '/reviews', icon: ClipboardCheck, badge: pendingReviews },
        { label: 'Processing Runs', to: '/runs', icon: Activity },
      ],
    },
    {
      title: 'Procurement',
      items: [
        { label: 'Purchase Orders', to: '/purchase-orders', icon: ShoppingCart },
        { label: 'Vendors', to: '/vendors', icon: Building2 },
      ],
    },
    {
      title: 'Insights',
      items: [
        { label: 'Analytics & Reports', to: '/analytics', icon: BarChart3 },
        { label: 'Audit Trail', to: '/audit', icon: History, roles: ['REVIEWER', 'ADMIN'] },
      ],
    },
    {
      title: 'Administration',
      items: [{ label: 'Settings', to: '/settings', icon: Settings }],
    },
  ];

  const getBreadcrumb = (): string[] => {
    const path = location.pathname;
    if (path === '/') return ['Workspace', 'Overview'];
    if (path === '/invoices') return ['Workspace', 'Invoices'];
    if (path.startsWith('/invoices/')) return ['Workspace', 'Invoices', 'Processing Workspace'];
    if (path === '/upload') return ['Workspace', 'Upload Invoices'];
    if (path === '/reviews') return ['Workspace', 'Review Queue'];
    if (path === '/runs') return ['Workspace', 'Processing Runs'];
    if (path === '/purchase-orders') return ['Procurement', 'Purchase Orders'];
    if (path === '/vendors') return ['Procurement', 'Vendors'];
    if (path === '/analytics') return ['Insights', 'Analytics & Reports'];
    if (path === '/audit') return ['Insights', 'Audit Trail'];
    if (path === '/settings') return ['Administration', 'Settings'];
    return ['InvoiceDesk'];
  };

  const breadcrumbs = getBreadcrumb();

  const renderSidebarContent = (isMobile = false) => (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 select-none">
      <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <Link
          to="/"
          className="font-display font-bold text-[17px] tracking-tight text-slate-900 dark:text-slate-50 whitespace-nowrap truncate"
        >
          {collapsed && !isMobile ? 'ID' : 'InvoiceDesk'}
        </Link>
        {!isMobile ? (
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        ) : (
          <button
            onClick={() => setMobileOpen(false)}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="p-3">
        <Button
          variant="primary"
          className="w-full"
          onClick={() => navigate('/upload')}
          title="Upload Invoice PDF"
        >
          <Plus className="w-4 h-4 shrink-0" />
          {(!collapsed || isMobile) && <span>Upload Invoice</span>}
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-5">
        {navGroups.map((group) => {
          const visibleItems = group.items.filter(
            (item) => !item.roles || (user && item.roles.includes(user.role))
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={group.title}>
              {(!collapsed || isMobile) && (
                <div className="px-2.5 mb-1.5 text-[11px] font-semibold tracking-wider text-slate-400 dark:text-slate-500 uppercase">
                  {group.title}
                </div>
              )}
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      title={item.label}
                      className={({ isActive }) =>
                        `flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                          isActive
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
                        }`
                      }
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Icon className="w-4 h-4 shrink-0" />
                        {(!collapsed || isMobile) && <span className="truncate">{item.label}</span>}
                      </span>
                      {(!collapsed || isMobile) && typeof item.badge === 'number' && item.badge > 0 && (
                        <span className="font-mono tabular-nums text-[11px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300">
                          {item.badge}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {(!collapsed || isMobile) && user && (
        <div className="p-3 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
          <div className="font-medium text-slate-800 dark:text-slate-200 truncate">{user.full_name}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span>{user.role}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{user.email}</span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100">
      {/* Desktop / Tablet Sidebar */}
      <aside className={`hidden md:block shrink-0 transition-all duration-150 ${collapsed ? 'w-16' : 'w-60'}`}>
        <div className="sticky top-0 h-screen">{renderSidebarContent(false)}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div className="w-64 h-full">{renderSidebarContent(true)}</div>
          <div className="flex-1 bg-slate-950/50" onClick={() => setMobileOpen(false)} />
        </div>
      )}

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="sticky top-0 z-30 h-14 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 px-4 lg:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm min-w-0">
              {breadcrumbs.map((crumb, idx) => (
                <React.Fragment key={crumb}>
                  {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                  <span
                    className={`truncate ${
                      idx === breadcrumbs.length - 1
                        ? 'font-semibold text-slate-900 dark:text-slate-100'
                        : 'text-slate-500 dark:text-slate-400 hidden sm:inline'
                    }`}
                  >
                    {crumb}
                  </span>
                </React.Fragment>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setSearchOpen(true)}
              className="hidden sm:flex items-center gap-2 h-8 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer whitespace-nowrap"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search invoices, POs, vendors</span>
              <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                ⌘K
              </kbd>
            </button>
            <button
              onClick={() => setSearchOpen(true)}
              className="sm:hidden p-2 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              aria-label="Search"
            >
              <Search className="w-4 h-4" />
            </button>

            {/* Notifications */}
            <div className="relative">
              <button
                onClick={() => setNotifOpen((o) => !o)}
                className="relative p-2 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Notifications"
              >
                <Bell className="w-4 h-4" />
                {(notifData?.unread_count ?? 0) > 0 && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-500" />
                )}
              </button>
              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl z-40 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Attention Required ({notifData?.unread_count ?? 0})
                    </span>
                    <button
                      onClick={() => setNotifOpen(false)}
                      className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      Close
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                    {!notifData?.items?.length ? (
                      <div className="p-4 text-xs text-slate-500 text-center flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        No pending exceptions or failures.
                      </div>
                    ) : (
                      notifData.items.map((n) => (
                        <button
                          key={n.invoice_id}
                          onClick={() => navigate(`/invoices/${n.invoice_id}`)}
                          className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                              {n.invoice_number || n.original_filename}
                            </span>
                            <span className="text-[11px] font-mono text-amber-700 dark:text-amber-300 shrink-0">
                              {n.processing_status === 'FAILED' ? 'FAILED' : n.primary_reason_code || 'REVIEW'}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 truncate">{n.original_filename}</div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="p-2 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              aria-label="Toggle Light/Dark theme"
              title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            {/* User Profile + Demo Role Switcher */}
            {user && (
              <div className="relative">
                <button
                  onClick={() => setProfileOpen((o) => !o)}
                  className="flex items-center gap-2 h-8 pl-2 pr-2.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs cursor-pointer whitespace-nowrap"
                >
                  <span className="w-5 h-5 rounded bg-blue-600 text-white font-semibold flex items-center justify-center text-[11px]">
                    {user.full_name.charAt(0)}
                  </span>
                  <span className="hidden lg:inline font-medium text-slate-800 dark:text-slate-200">
                    {user.full_name}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {user.role}
                  </span>
                </button>
                {profileOpen && (
                  <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl z-40 p-2">
                    <div className="px-2.5 py-2 border-b border-slate-100 dark:border-slate-800">
                      <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">{user.full_name}</div>
                      <div className="text-[11px] text-slate-500 truncate">{user.email}</div>
                    </div>
                    {user.demo_mode && (
                      <div className="py-2 border-b border-slate-100 dark:border-slate-800">
                        <div className="px-2.5 pb-1 text-[11px] font-medium text-slate-400">
                          Switch Demo Persona (RBAC)
                        </div>
                        {(['OPERATOR', 'REVIEWER', 'ADMIN'] as UserRole[]).map((r) => (
                          <button
                            key={r}
                            onClick={() => {
                              void switchDemoRole(r);
                              setProfileOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer ${
                              user.role === r
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                          >
                            <span className="flex items-center gap-2">
                              <UserCheck className="w-3.5 h-3.5" />
                              {r}
                            </span>
                            {user.role === r && <span>Active</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    {user.auth_paused ? (
                      <div className="px-2.5 py-2 mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                        Authentication paused for live demo
                      </div>
                    ) : (
                      <button
                        onClick={() => void logout()}
                        className="w-full flex items-center gap-2 px-2.5 py-2 mt-1 rounded text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Sign Out
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 p-4 lg:p-6 max-w-[1600px] w-full mx-auto">{children}</main>
      </div>

      {/* Global Command Search Modal */}
      <Modal open={searchOpen} onClose={() => setSearchOpen(false)} title="Global Search">
        <div className="space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by invoice #, filename, PO #, or vendor..."
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {!searchQuery.trim() ? (
            <div className="text-xs text-slate-500 py-4 text-center">
              Type an invoice number (e.g. INV-2026), PO number (PO-2026-300), or vendor name.
            </div>
          ) : (
            <div className="space-y-4 max-h-80 overflow-y-auto">
              {searchResults?.invoices?.length ? (
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 uppercase mb-1.5">Invoices</div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-md">
                    {searchResults.invoices.map((inv) => (
                      <button
                        key={inv.id}
                        onClick={() => {
                          setSearchOpen(false);
                          navigate(`/invoices/${inv.id}`);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {inv.invoice_number || inv.original_filename}
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            {formatCurrency(inv.total_amount, inv.currency)}
                          </span>
                          <DecisionBadge outcome={inv.business_decision} />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {searchResults?.purchase_orders?.length ? (
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 uppercase mb-1.5">Purchase Orders</div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-md">
                    {searchResults.purchase_orders.map((po) => (
                      <button
                        key={po.id}
                        onClick={() => {
                          setSearchOpen(false);
                          navigate(`/purchase-orders?po=${po.id}`);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <span className="font-mono font-medium text-slate-900 dark:text-slate-100">
                          {po.po_number} · {po.vendor_name}
                        </span>
                        <span className="font-mono tabular-nums text-slate-500">
                          {formatCurrency(po.original_amount)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {searchResults?.vendors?.length ? (
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 uppercase mb-1.5">Vendors</div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-md">
                    {searchResults.vendors.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => {
                          setSearchOpen(false);
                          navigate(`/vendors?vendor=${v.id}`);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <span className="font-medium text-slate-900 dark:text-slate-100">{v.canonical_name}</span>
                        <span className="font-mono text-[11px] text-slate-500">{v.verification_status}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {!searchResults?.invoices?.length &&
                !searchResults?.purchase_orders?.length &&
                !searchResults?.vendors?.length && (
                  <div className="text-xs text-slate-500 py-4 text-center">No matching records found.</div>
                )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
