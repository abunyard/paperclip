// wabnet fork: create an `anthropic_compatible` AI connection (MiniMax, Alibaba Token Plan,
// Switchyard, or a custom Anthropic Messages endpoint). The key lives only in this form's
// state until it is sent to the server; it is cleared after save or cancel.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ANTHROPIC_COMPATIBLE_PRESETS,
  ANTHROPIC_COMPATIBLE_PRESET_IDS,
  isAllowedAnthropicCompatibleBaseUrl,
  type AnthropicCompatibleEndpointInput,
  type AnthropicCompatiblePreset,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MODEL_SLOTS = [
  ["main", "Main model"],
  ["opus", "Opus slot"],
  ["sonnet", "Sonnet slot"],
  ["haiku", "Haiku slot (background tasks)"],
  ["subagent", "Subagent model"],
] as const;
type ModelSlot = (typeof MODEL_SLOTS)[number][0];
const NONE = "__none__";

export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean))];
}

export function AnthropicCompatibleEndpointForm({
  companyId,
  agentIds = [],
  ownership = "shared",
  initialName,
  onComplete,
  onCancel,
}: {
  companyId: string;
  agentIds?: string[];
  ownership?: "personal" | "shared";
  initialName?: string;
  onComplete: (result: { connectionId: string; grantId: string; method: "api_key"; models: string[] }) => void;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const [preset, setPreset] = useState<AnthropicCompatiblePreset>("minimax");
  const [name, setName] = useState(initialName ?? ANTHROPIC_COMPATIBLE_PRESETS.minimax.label);
  const [baseUrl, setBaseUrl] = useState<string>(ANTHROPIC_COMPATIBLE_PRESETS.minimax.baseUrl);
  const [authHeader, setAuthHeader] = useState<"bearer" | "x-api-key">("bearer");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [modelMap, setModelMap] = useState<Partial<Record<ModelSlot, string>>>({});
  const [disableBetas, setDisableBetas] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const models = parseModelList(modelsText);
  const urlOk = isAllowedAnthropicCompatibleBaseUrl(baseUrl.trim());

  const endpoint = (): AnthropicCompatibleEndpointInput => ({
    baseUrl: baseUrl.trim(),
    authHeader,
    preset,
    models,
    modelMap: Object.fromEntries(Object.entries(modelMap).filter(([, v]) => v && models.includes(v))),
    billing: { type: "fixed", biller: ANTHROPIC_COMPATIBLE_PRESETS[preset].biller },
    clientFlags: { disableExperimentalBetas: disableBetas, disableNonessentialTraffic: true },
  });

  const choosePreset = (next: AnthropicCompatiblePreset) => {
    setPreset(next);
    setBaseUrl(ANTHROPIC_COMPATIBLE_PRESETS[next].baseUrl);
    if (!initialName) setName(ANTHROPIC_COMPATIBLE_PRESETS[next].label);
    setNotice(null);
  };
  const discover = useMutation({
    mutationFn: () => aiConnectionsApi.listAnthropicCompatibleModels(companyId, { endpoint: endpoint(), apiKey: apiKey.trim() }),
    onSuccess: (result) => {
      setModelsText(result.models.join("\n"));
      setNotice(result.models.length ? `Found ${result.models.length} models.` : "The endpoint listed no models. Enter model ids by hand.");
    },
  });
  const test = useMutation({
    mutationFn: () => aiConnectionsApi.testAnthropicCompatible(companyId, { endpoint: endpoint(), apiKey: apiKey.trim() }),
    onSuccess: () => setNotice("The endpoint accepted this key and model."),
  });
  const save = useMutation({
    mutationFn: () =>
      aiConnectionsApi.create(companyId, {
        provider: "anthropic_compatible",
        method: "api_key",
        name: name.trim(),
        ownership,
        agentIds,
        allAgents: false,
        apiKey: apiKey.trim(),
        endpoint: endpoint(),
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["ai-connections", companyId] });
      onComplete({ ...result, method: "api_key", models });
    },
    onSettled: () => setApiKey(""),
  });
  const busy = discover.isPending || test.isPending || save.isPending;
  const error = (save.error ?? test.error ?? discover.error)?.message;
  const canProbe = urlOk && apiKey.trim().length > 0 && !busy;
  const canSave = canProbe && name.trim().length > 0 && (models.length > 0 || Boolean(modelMap.main));
  const discoveryHint = ANTHROPIC_COMPATIBLE_PRESETS[preset].discovery === "v1_models"
    ? "This endpoint lists its models."
    : "This endpoint may not list models; enter model ids by hand.";

  return (
    <div className="mx-auto w-full min-w-0 max-w-xl space-y-4" aria-label="Anthropic-compatible endpoint">
      <label className="block space-y-2 text-sm">
        Endpoint
        <Select value={preset} onValueChange={(v) => choosePreset(v as AnthropicCompatiblePreset)}>
          <SelectTrigger aria-label="Endpoint preset"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ANTHROPIC_COMPATIBLE_PRESET_IDS.map((id) => (
              <SelectItem key={id} value={id}>{ANTHROPIC_COMPATIBLE_PRESETS[id].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block space-y-2 text-sm">
        Base URL
        <Input aria-label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://gateway.example.com" />
        {baseUrl.trim() && !urlOk && <span className="block text-xs text-destructive">Use https (plain http only for 127.0.0.1 or localhost), without credentials or query.</span>}
      </label>
      <label className="block space-y-2 text-sm">
        Auth header
        <Select value={authHeader} onValueChange={(v) => setAuthHeader(v as "bearer" | "x-api-key")}>
          <SelectTrigger aria-label="Auth header"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="bearer">Authorization: Bearer (ANTHROPIC_AUTH_TOKEN)</SelectItem>
            <SelectItem value="x-api-key">x-api-key (ANTHROPIC_API_KEY)</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="block space-y-2 text-sm">
        API key
        <Input aria-label="API key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Enter API key here" />
      </label>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span>Models</span>
          <Button type="button" variant="outline" size="sm" disabled={!canProbe} onClick={() => discover.mutate()}>
            {discover.isPending ? "Listing…" : "Discover models"}
          </Button>
        </div>
        <Textarea aria-label="Models" value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder="One model id per line, e.g. MiniMax-M3" rows={3} />
        <p className="text-xs text-muted-foreground">{discoveryHint}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {MODEL_SLOTS.map(([slot, label]) => (
          <label key={slot} className="block space-y-1 text-xs">
            {label}
            <Select value={modelMap[slot] ?? NONE} onValueChange={(v) => setModelMap((m) => ({ ...m, [slot]: v === NONE ? undefined : v }))}>
              <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not set</SelectItem>
                {models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={disableBetas} onChange={(e) => setDisableBetas(e.target.checked)} />
        Disable experimental Claude Code features (for endpoints that reject unknown request fields)
      </label>
      <p className="text-xs text-muted-foreground">
        Billing: fixed plan (0 cents; tokens are still tracked) under “{ANTHROPIC_COMPATIBLE_PRESETS[preset].biller}”.
        Agents run Claude Code against this endpoint; Anthropic does not support non-Claude models behind a gateway.
      </p>
      {notice && !error && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="ghost" onClick={() => { setApiKey(""); onCancel(); }}>Cancel</Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={!canProbe || !(modelMap.main || models.length)} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test"}
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => save.mutate()}>{save.isPending ? "Connecting…" : "Connect"}</Button>
        </div>
      </div>
    </div>
  );
}
