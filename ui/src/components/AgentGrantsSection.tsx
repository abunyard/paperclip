// wabnet L0011: grant permissions to an existing agent (PUT /agents/:id/grants).
// Board users with users:manage_permissions only; the server enforces this and refuses
// grant-conferring keys. tasks:assign stays on the "Can assign tasks" toggle above.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/** Mirrors the server's refused + managed-elsewhere sets (routes/agents.ts). */
export const AGENT_GRANT_HIDDEN_KEYS = new Set(["users:manage_permissions", "users:invite", "joins:approve", "tasks:assign"]);
export const GRANTABLE_AGENT_PERMISSION_KEYS = PERMISSION_KEYS.filter((key) => !AGENT_GRANT_HIDDEN_KEYS.has(key));

export function AgentGrantsSection({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const client = useQueryClient();
  const queryKey = ["agents", "grants", agentId];
  const grants = useQuery({ queryKey, queryFn: () => agentsApi.grants(agentId, companyId) });
  const current = grants.data?.grants ?? [];
  const has = (key: string) => current.some((g) => g.permissionKey === key);
  const toggle = useMutation({
    mutationFn: (key: string) =>
      has(key)
        ? agentsApi.setGrants(agentId, {
            // Removal is an explicit replace of everything else (tasks:assign is preserved server-side).
            grants: current.filter((g) => g.permissionKey !== key && !AGENT_GRANT_HIDDEN_KEYS.has(g.permissionKey)),
            replace: true,
          }, companyId)
        : agentsApi.setGrants(agentId, { grants: [{ permissionKey: key }] }, companyId),
    onSuccess: (result) => client.setQueryData(queryKey, result),
  });
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" aria-label="Permission grants">
      <div>
        <h3 className="text-sm font-semibold">Permission grants</h3>
        <p className="text-xs text-muted-foreground">
          Explicit company permissions for this agent. Needs users:manage_permissions. Suggest-changes grants still require
          the operator to accept each change.
        </p>
      </div>
      {grants.error && <p role="alert" className="text-sm text-destructive">{grants.error.message}</p>}
      {toggle.error && <p role="alert" className="text-sm text-destructive">{toggle.error.message}</p>}
      {grants.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">Loading grants…</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {GRANTABLE_AGENT_PERMISSION_KEYS.map((key) => (
            <label key={key} className="flex items-center justify-between gap-3 text-sm">
              <code className="text-xs">{key}</code>
              <ToggleSwitch
                aria-label={key}
                checked={has(key)}
                onCheckedChange={() => toggle.mutate(key)}
                disabled={toggle.isPending || Boolean(grants.error)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
