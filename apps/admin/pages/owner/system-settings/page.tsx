import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Checkbox } from "@frely/ui/components/checkbox";
import { Input } from "@frely/ui/components/input";
import { PageHeading, StatusBadge } from "../_components/ui";
import { PipelinePluginSettings } from "../../../features/system-settings/components/pipeline-plugin-settings";
import { RequestCaptureToggle } from "../../../features/system-settings/components/request-capture-toggle";
import { PublicHostsPanel } from "../../../features/public-hosts/components/public-hosts-panel";
import { WebRegistrationCard } from "../../../features/web-registration/components/web-registration-card";
import type { SystemSettingsPageData } from "./page-data";

export default function SystemSettingsPage({ data: loaded }: { data: SystemSettingsPageData }) {
  if (!loaded) return null;
  const { config, requestCapture, pipelinePlugins, versions, publicHostPolicy, registrationSetting, publicHosts } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="System Settings"
        title="System Settings"
        description="Configure environment-wide defaults for relay behavior, retention, and operational guardrails."
      >
        <Button type="button" variant="secondary">
          Reset
        </Button>
        <Button type="button">
          Save Settings
        </Button>
      </PageHeading>

      <section className="split-grid">
        <Card className="panel">
          <div className="panel-heading">
            <div>
              <h2>Environment Defaults</h2>
              <p className="muted">Global settings applied before team and key-specific overrides.</p>
            </div>
            <StatusBadge tone="info">{config.environment}</StatusBadge>
          </div>
          <div className="form-grid">
            <label>
              Environment
              <Input defaultValue={config.environment} readOnly />
            </label>
            <label>
              Release Version
              <Input defaultValue={displayReleaseVersion(config.releaseVersion)} readOnly />
            </label>
            <label>
              Public Base URL
              <Input defaultValue={config.publicBaseUrl} readOnly />
            </label>
            <label>
              Logging Level
              <Input defaultValue={config.loggingLevel} readOnly />
            </label>
          </div>
        </Card>

        <Card className="panel">
          <div className="panel-heading">
            <h2>Guardrails</h2>
          </div>
          <div className="toggle-row" role="note">
            <StatusBadge tone="neutral">Read-only</StatusBadge>
            Scope visibility is derived from AccessPoints
          </div>
          <label className="toggle-row">
            <Checkbox defaultChecked />
            Apply Budget Policies hard-stop checks
          </label>
          <label className="toggle-row">
            <Checkbox defaultChecked />
            Capture administrative audit events
          </label>
          <RequestCaptureToggle initialEnabled={requestCapture.enabled} />
        </Card>
      </section>
      <WebRegistrationCard initial={registrationSetting} />
      <PublicHostsPanel
        defaultHost={{ hostname: publicHostPolicy.canonicalHostname, origin: publicHostPolicy.canonicalOrigin }}
        aliases={publicHosts}
      />
      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>Runtime Artifact Versions</h2>
            <p className="muted">Artifact versions are reported by running services and remain separate from the deployed Release Version. CLIProxyAPI reports its binary identity separately from the Compose-pinned image.</p>
          </div>
        </div>
        <div className="form-grid">
          {versions.map((item) => (
            <label key={item.service}>
              {item.service}
              <Input defaultValue={item.version.startsWith("v") ? item.version : `v${item.version}`} readOnly />
              <span className="muted"><StatusBadge tone={item.availability === "error" ? "bad" : item.availability === "unavailable" ? "warn" : "neutral"}>{item.availability}</StatusBadge> {item.detail}</span>
            </label>
          ))}
        </div>
      </Card>
      <PipelinePluginSettings initialPlugins={pipelinePlugins} />
    </>
  );
}

function displayReleaseVersion(version: string): string {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version) ? `v${version}` : version;
}
