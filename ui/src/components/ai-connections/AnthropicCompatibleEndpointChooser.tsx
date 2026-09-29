// wabnet fork: pick (or add) the Anthropic-compatible endpoint a claude_local agent runs on.
// The choice is a shared binding to one connection, so each agent can use a different endpoint.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { Button } from "@/components/ui/button";
import { AnthropicCompatibleEndpointForm } from "./AnthropicCompatibleEndpointForm";

export function endpointBinding(connection: { id: string; grantId: string }): AiConnectionBinding {
  return { provider: "anthropic_compatible", method: "api_key", mode: "shared", connectionId: connection.id, grantId: connection.grantId };
}

export function AnthropicCompatibleEndpointChooser({
  companyId,
  agentId,
  value,
  onChange,
  onCancel,
}: {
  companyId: string;
  agentId?: string;
  value?: AiConnectionBinding;
  onChange: (binding: AiConnectionBinding) => void;
  onCancel?: () => void;
}) {
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
  });
  const endpoints = (accounts.data?.connections ?? []).filter(
    (c) => c.provider === "anthropic_compatible" && c.ownership === "shared",
  );
  const [adding, setAdding] = useState(false);
  if (accounts.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading endpoints…</p>;
  if (adding || (!endpoints.length && !accounts.error))
    return (
      <AnthropicCompatibleEndpointForm
        companyId={companyId}
        agentIds={agentId ? [agentId] : []}
        onCancel={() => (endpoints.length ? setAdding(false) : onCancel?.())}
        onComplete={(result) => {
          setAdding(false);
          onChange(endpointBinding({ id: result.connectionId, grantId: result.grantId }));
        }}
      />
    );
  return (
    <div className="space-y-3" aria-label="Anthropic-compatible endpoints">
      {accounts.error && <p role="alert" className="text-sm text-destructive">{accounts.error.message}</p>}
      <ConnectionChoiceList
        selectedId={value?.mode === "shared" ? value.connectionId : undefined}
        choices={endpoints.map((c) => ({
          id: c.id,
          name: c.name,
          description: <>{c.endpoint?.baseUrl ?? "endpoint"}{c.endpoint?.models.length ? ` · ${c.endpoint.models.length} models` : ""}{c.status !== "connected" ? ` · ${c.status}` : ""}</>,
          disabled: c.status !== "connected",
        }))}
        onSelect={(id) => {
          const connection = endpoints.find((c) => c.id === id);
          if (connection) onChange(endpointBinding(connection));
        }}
      />
      <div className="flex justify-between gap-2">
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Back</Button> : <span />}
        <Button type="button" variant="outline" onClick={() => setAdding(true)}>Add endpoint</Button>
      </div>
    </div>
  );
}
