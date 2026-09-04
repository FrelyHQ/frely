"use client";

import { useRef, useState, type KeyboardEvent } from "react";

type LandingAudience = "operator" | "user";

const audiences: Array<{ id: LandingAudience; label: string }> = [
  { id: "operator", label: "中转站主理人" },
  { id: "user", label: "普通用户" }
];

export function LandingAudienceTabs({ loginHref = "/user" }: { loginHref?: string }) {
  const [audience, setAudience] = useState<LandingAudience>("operator");
  const tabRefs = useRef<Record<LandingAudience, HTMLButtonElement | null>>({ operator: null, user: null });

  function selectAudience(next: LandingAudience) {
    setAudience(next);
    tabRefs.current[next]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectAudience(audience === "operator" ? "user" : "operator");
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectAudience(event.key === "Home" ? "operator" : "user");
    }
  }

  const isOperator = audience === "operator";

  return (
    <>
      <section className="landing-audience" aria-label="选择你的使用方式">
        <div className="landing-shell">
          <div className="landing-audience-tabs" role="tablist" aria-label="Frely 使用角色">
            {audiences.map((item) => (
              <button
                aria-controls={`landing-${item.id}-panel`}
                aria-selected={audience === item.id}
                className="landing-audience-tab"
                id={`landing-${item.id}-tab`}
                key={item.id}
                onClick={() => setAudience(item.id)}
                onKeyDown={handleTabKeyDown}
                ref={(node) => { tabRefs.current[item.id] = node; }}
                role="tab"
                tabIndex={audience === item.id ? 0 : -1}
                type="button"
              >
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div
        aria-labelledby={`landing-${audience}-tab`}
        className={`landing-audience-panel ${isOperator ? "is-operator" : "is-user"}`}
        id={`landing-${audience}-panel`}
        role="tabpanel"
        tabIndex={0}
      >
        <section className="landing-shell landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">{isOperator ? "Team-owned AI Relay" : "AI access for every member"}</p>
            {isOperator ? (
              <h1 id="landing-title">建立自己的<span>AI 中转站</span></h1>
            ) : (
              <h1 id="landing-title" className="landing-user-title">直接使用可靠的<span>AI 模型</span></h1>
            )}
            {isOperator ? (
              <p className="landing-lede">
                创建属于你的 <strong>Team</strong>，成为中转站主人，把可靠的模型能力转发给成员与客户。
                Frely 为每一次运营准备好 API Key、模型接入、套餐、余额和用量管理。
              </p>
            ) : (
              <p className="landing-lede">
                加入你的 <strong>Team</strong>，查看真正可用的模型，管理自己的 API Key、套餐、余额和调用记录。
                复杂的上游接入由 Frely 处理，你只需要选择模型并开始调用。
              </p>
            )}
            <div className="landing-hero-actions">
              <a className="landing-primary-cta" href={loginHref}>
                <span>{isOperator ? "进入我的中转站" : "进入用户控制台"}</span>
                <span aria-hidden="true">→</span>
              </a>
              <span className="landing-cta-note">
                {isOperator ? "独立域名 · 专属部署 · 持续服务" : "可用模型 · API Key · 套餐与用量"}
              </span>
            </div>
          </div>

          {isOperator ? <OperatorPreview /> : <UserPreview />}
        </section>

        <section className="landing-proof" aria-label={isOperator ? "主理人能力概览" : "普通用户能力概览"}>
          <div className="landing-shell landing-proof-grid">
            <p>{isOperator ? "一个 Team，就是一个可运营的中转站。" : "加入一个 Team，即可开始使用模型。"}</p>
            {isOperator ? (
              <>
                <div><strong>模型接入</strong><span>统一入口，灵活组合</span></div>
                <div><strong>服务管理</strong><span>Key、套餐、余额与用量</span></div>
                <div><strong>品牌交付</strong><span>独立域名与部署服务</span></div>
              </>
            ) : (
              <>
                <div><strong>可用模型</strong><span>只展示你真正能调用的能力</span></div>
                <div><strong>自己的 Key</strong><span>创建、停用和查看调用记录</span></div>
                <div><strong>消费视图</strong><span>套餐、余额、预算与用量清晰可见</span></div>
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function OperatorPreview() {
  return (
    <div className="landing-operator-stage" aria-label="Team 中转站运营示意">
      <article className="landing-operator-card">
        <div className="landing-card-kicker"><span>Relay Operator</span><span className="landing-live">服务中</span></div>
        <div className="landing-owner-row">
          <span className="landing-owner-avatar" aria-hidden="true">YT</span>
          <div><h2>Your Team</h2><p>你是 Team Owner · 中转站主人</p></div>
        </div>
        <div className="landing-operator-metrics" aria-label="示例中转站能力">
          <div><span>模型入口</span><strong>统一管理</strong></div>
          <div><span>成员服务</span><strong>按 Team 交付</strong></div>
        </div>
        <div className="landing-relay-flow" aria-label="模型能力转发流程">
          <span>Provider</span><i aria-hidden="true" /><span>Frely</span><i aria-hidden="true" /><span>Member</span>
        </div>
        <div className="landing-domain-chip">
          <span aria-hidden="true" />
          <div><small>独立域名</small><strong>relay.your-brand.com</strong></div>
          <b>READY</b>
        </div>
      </article>
      <span className="landing-owner-stamp" aria-hidden="true">OWN<br />THE<br />RELAY</span>
    </div>
  );
}

function UserPreview() {
  return (
    <div className="landing-operator-stage landing-user-stage" aria-label="普通用户控制台示意">
      <article className="landing-operator-card landing-user-card">
        <div className="landing-card-kicker"><span>User Workspace</span><span className="landing-live">已连接</span></div>
        <div className="landing-owner-row">
          <span className="landing-owner-avatar" aria-hidden="true">ME</span>
          <div><h2>个人控制台</h2><p>Team Member · 普通用户</p></div>
        </div>
        <div className="landing-operator-metrics" aria-label="普通用户能力">
          <div><span>可用模型</span><strong>按权限展示</strong></div>
          <div><span>API Key</span><strong>自主管理</strong></div>
        </div>
        <div className="landing-relay-flow" aria-label="普通用户调用流程">
          <span>Model</span><i aria-hidden="true" /><span>API Key</span><i aria-hidden="true" /><span>Your App</span>
        </div>
        <div className="landing-domain-chip landing-user-chip">
          <span aria-hidden="true" />
          <div><small>账户状态</small><strong>套餐、余额与用量均可查看</strong></div>
          <b>READY</b>
        </div>
      </article>
      <span className="landing-owner-stamp landing-user-stamp" aria-hidden="true">USE<br />THE<br />RELAY</span>
    </div>
  );
}
