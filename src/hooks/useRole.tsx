import React, { useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import type { UserProfile, UserRole } from '../lib/api';

export type RoleInput =
  | UserRole
  | 'Admin'
  | 'Manager'
  | 'Reviewer'
  | 'Operator'
  | 'Auditor'
  | 'ADMIN'
  | 'MANAGER'
  | (string & {});

export type RoleCapability =
  | 'approve_invoice'
  | 'reject_invoice'
  | 'delete_resource'
  | 'manage_master_data'
  | 'verify_vendor'
  | 'ai_decision_mutate'
  | 'operate_pipeline'
  | 'view_audit_trail'
  | 'manage_settings';

const CAPABILITY_ROLES: Record<RoleCapability, UserRole[]> = {
  approve_invoice: ['ADMIN', 'REVIEWER'],
  reject_invoice: ['ADMIN', 'REVIEWER'],
  delete_resource: ['ADMIN'],
  manage_master_data: ['ADMIN'],
  verify_vendor: ['ADMIN', 'REVIEWER'],
  ai_decision_mutate: ['ADMIN', 'REVIEWER'],
  operate_pipeline: ['OPERATOR', 'REVIEWER', 'ADMIN'],
  view_audit_trail: ['REVIEWER', 'AUDITOR', 'ADMIN'],
  manage_settings: ['ADMIN'],
};

/**
 * Normalizes role labels (e.g. 'Admin' -> 'ADMIN', 'Manager' -> 'REVIEWER')
 * so UI components can target either InvoiceDesk canonical RBAC roles or
 * standard organizational labels ('Admin', 'Manager').
 */
export function normalizeRole(input: RoleInput): UserRole | null {
  const normalized = String(input ?? '').trim().toUpperCase();
  if (normalized === 'ADMIN') return 'ADMIN';
  if (normalized === 'MANAGER' || normalized === 'REVIEWER') return 'REVIEWER';
  if (normalized === 'OPERATOR') return 'OPERATOR';
  if (normalized === 'AUDITOR') return 'AUDITOR';
  return null;
}

export function checkUserRoles(
  userRole: UserRole | null | undefined,
  allowedRoles?: RoleInput | RoleInput[] | null,
  capability?: RoleCapability
): boolean {
  if (!userRole) return false;
  if (capability) {
    const requiredForCap = CAPABILITY_ROLES[capability];
    if (!requiredForCap.includes(userRole)) return false;
  }
  if (allowedRoles === undefined || allowedRoles === null) {
    return true;
  }
  const list = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (list.length === 0) return true;
  return list.some((candidate) => normalizeRole(candidate) === userRole);
}

export interface RoleGateProps {
  /** Allowed roles (supports 'ADMIN' | 'REVIEWER' | 'OPERATOR' | 'AUDITOR' as well as 'Admin' | 'Manager'). */
  roles?: RoleInput | RoleInput[];
  /** Optional semantic capability check. */
  capability?: RoleCapability;
  /** Additional boolean predicate that must also be true to render children. */
  when?: boolean;
  /** Optional fallback content rendered when the user lacks the required role. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Declarative wrapper component that conditionally renders UI elements
 * (such as Approve, Reject, Delete, or Admin-only controls) based on the active user's role.
 */
export function RoleGate({
  roles,
  capability,
  when = true,
  fallback = null,
  children,
}: RoleGateProps) {
  const { user, loading } = useAuth();
  if (loading || !user || !when) {
    return <>{fallback}</>;
  }
  const allowed = checkUserRoles(user.role, roles, capability);
  return <>{allowed ? children : fallback}</>;
}

export const RoleGuard = RoleGate;

export interface UseRoleResult {
  user: UserProfile | null;
  role: UserRole | null;
  loading: boolean;
  hasAccess: boolean;
  isAdmin: boolean;
  isManager: boolean;
  isReviewer: boolean;
  isOperator: boolean;
  isAuditor: boolean;
  canDecide: boolean;
  canOperate: boolean;
  canDelete: boolean;
  canViewAudit: boolean;
  hasRole: (allowedRoles: RoleInput | RoleInput[]) => boolean;
  can: (capability: RoleCapability) => boolean;
  RoleGate: React.FC<RoleGateProps>;
}

/**
 * Hook providing RBAC checks and a bound `RoleGate` wrapper component to
 * conditionally render restricted UI elements (e.g., Approve, Reject, Delete)
 * only for authorized roles such as Admin or Manager (Reviewer).
 */
export function useRole(
  defaultRequirement?: RoleInput | RoleInput[] | { roles?: RoleInput | RoleInput[]; capability?: RoleCapability }
): UseRoleResult {
  const { user, loading } = useAuth();
  const role = user?.role ?? null;

  const { defaultRoles, defaultCapability, requirementKey } = useMemo(() => {
    if (!defaultRequirement) {
      return { defaultRoles: undefined, defaultCapability: undefined, requirementKey: '' };
    }
    if (typeof defaultRequirement === 'string' || Array.isArray(defaultRequirement)) {
      const list = Array.isArray(defaultRequirement) ? defaultRequirement : [defaultRequirement];
      return {
        defaultRoles: list,
        defaultCapability: undefined,
        requirementKey: `roles:${list.map((r) => String(r)).join(',')}`,
      };
    }
    const rolesList = defaultRequirement.roles
      ? Array.isArray(defaultRequirement.roles)
        ? defaultRequirement.roles
        : [defaultRequirement.roles]
      : undefined;
    return {
      defaultRoles: rolesList,
      defaultCapability: defaultRequirement.capability,
      requirementKey: `roles:${rolesList?.map((r) => String(r)).join(',') ?? ''}|cap:${defaultRequirement.capability ?? ''}`,
    };
  }, [defaultRequirement]);

  const hasRole = useCallback(
    (allowedRoles: RoleInput | RoleInput[]) => checkUserRoles(role, allowedRoles),
    [role]
  );

  const can = useCallback(
    (capability: RoleCapability) => checkUserRoles(role, undefined, capability),
    [role]
  );

  const hasAccess = useMemo(
    () => checkUserRoles(role, defaultRoles, defaultCapability),
    [role, defaultRoles, defaultCapability]
  );

  const BoundRoleGate = useMemo<React.FC<RoleGateProps>>(() => {
    if (!requirementKey) return RoleGate;
    const BoundGate: React.FC<RoleGateProps> = ({
      roles,
      capability,
      when = true,
      fallback = null,
      children,
    }) => (
      <RoleGate
        roles={roles ?? defaultRoles}
        capability={capability ?? defaultCapability}
        when={when}
        fallback={fallback}
      >
        {children}
      </RoleGate>
    );
    BoundGate.displayName = 'BoundRoleGate';
    return BoundGate;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirementKey]);

  return {
    user,
    role,
    loading,
    hasAccess,
    isAdmin: role === 'ADMIN',
    isManager: role === 'ADMIN' || role === 'REVIEWER',
    isReviewer: role === 'REVIEWER',
    isOperator: role === 'OPERATOR',
    isAuditor: role === 'AUDITOR',
    canDecide: checkUserRoles(role, undefined, 'approve_invoice'),
    canOperate: checkUserRoles(role, undefined, 'operate_pipeline'),
    canDelete: checkUserRoles(role, undefined, 'delete_resource'),
    canViewAudit: checkUserRoles(role, undefined, 'view_audit_trail'),
    hasRole,
    can,
    RoleGate: BoundRoleGate,
  };
}

/**
 * Higher-order component that wraps an entire page or section component
 * and only renders it when the active user satisfies the required roles.
 */
export function withRole<P extends object>(
  Component: React.ComponentType<P>,
  options: {
    roles?: RoleInput | RoleInput[];
    capability?: RoleCapability;
    fallback?: React.ReactNode;
  }
): React.FC<P> {
  const WrappedWithRole: React.FC<P> = (props) => (
    <RoleGate roles={options.roles} capability={options.capability} fallback={options.fallback ?? null}>
      <Component {...props} />
    </RoleGate>
  );
  WrappedWithRole.displayName = `withRole(${Component.displayName || Component.name || 'Component'})`;
  return WrappedWithRole;
}
