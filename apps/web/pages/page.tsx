import Link from "@web/navigation";
import { LandingAudienceTabs } from "./landing-audience-tabs";
import type { HomePageData } from "./page.server";

const operatorCapabilities = [
  { index: "01", title: "建立自己的 Team", description: "拥有清晰的 Team 身份与管理边界，把中转能力组织成真正属于你的服务空间。" },
  { index: "02", title: "转发可靠的模型能力", description: "通过统一的模型入口与 API Key，把可用能力安全地交付给成员和客户。" },
  { index: "03", title: "掌握每一次运营", description: "在同一个控制台查看套餐、余额、预算、调用记录和用量，让服务持续可控。" },
];

const steps = [
  ["创建 Team", "定义你的中转站身份与服务对象。"],
  ["接入模型", "组合可用模型能力与访问方式。"],
  ["交付服务", "为成员和客户准备 API Key 与套餐。"],
  ["品牌上线", "使用独立域名和部署服务正式对外。"],
] as const;

export default function HomePage({ data }: { data: HomePageData }) {
  if (data.kind === "domain") return <DomainLanding data={data} />;
  const { loginHref } = data;
  return (
    <div className="landing-page" lang="zh-CN">
      <a className="landing-skip-link" href="#landing-main">跳到主要内容</a>
      <header className="landing-header">
        <nav className="landing-shell landing-nav" aria-label="主要导航">
          <Link className="landing-brand" href="/" aria-label="Frely 首页">
            <span className="landing-brand-mark" aria-hidden="true" />
            <span>Frely</span>
          </Link>
          <div className="landing-nav-links">
            <a href="#operator">中转站主理人</a>
            <a href="#deployment">独立部署</a>
            <a className="landing-login" href={loginHref}>登录</a>
          </div>
        </nav>
      </header>

      <main id="landing-main">
        <LandingAudienceTabs loginHref={loginHref} />

        <section className="landing-section landing-operator-section" id="operator" aria-labelledby="operator-title">
          <div className="landing-shell">
            <div className="landing-section-heading">
              <p className="landing-section-index">01 / Own the relay</p>
              <div>
                <h2 id="operator-title">不只是调用 API，<br />而是经营自己的模型服务。</h2>
                <p>Frely 把 Team、模型能力与运营工具放进同一个工作空间，让你能清楚地向下服务。</p>
              </div>
            </div>
            <div className="landing-capability-grid">
              {operatorCapabilities.map((capability) => (
                <article className="landing-capability-card" key={capability.index}>
                  <span>{capability.index}</span>
                  <h3>{capability.title}</h3>
                  <p>{capability.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section landing-deployment-section" id="deployment" aria-labelledby="deployment-title">
          <div className="landing-shell landing-deployment-grid">
            <div className="landing-deployment-copy">
              <p className="landing-section-index">02 / Your brand, online</p>
              <h2 id="deployment-title">你的中转站，<br />也应该拥有自己的名字。</h2>
              <p>Frely 提供独立域名与部署服务，帮助你把内部能力整理成可对外使用的品牌入口。</p>
              <ul>
                <li>独立域名呈现你的品牌</li>
                <li>专属部署隔离服务边界</li>
                <li>从配置到上线的一站式协助</li>
              </ul>
            </div>
            <div className="landing-deployment-visual" aria-label="独立域名部署流程示意">
              <div className="landing-browser-card">
                <div className="landing-browser-bar"><i /><i /><i /><span>relay.your-brand.com</span></div>
                <div className="landing-browser-body">
                  <span className="landing-browser-brand">YOUR BRAND / RELAY</span>
                  <strong>模型服务已上线</strong>
                  <div className="landing-browser-status"><i />Domain verified · Deployment ready</div>
                </div>
              </div>
              <div className="landing-deploy-note"><span>F</span><p><small>Powered by</small><strong>Frely</strong></p></div>
            </div>
          </div>
        </section>

        <section className="landing-section landing-steps-section" aria-labelledby="steps-title">
          <div className="landing-shell">
            <div className="landing-steps-heading">
              <p className="landing-section-index">03 / From Team to service</p>
              <h2 id="steps-title">从一个 Team，走到正式服务。</h2>
            </div>
            <ol className="landing-steps">
              {steps.map(([title, description], index) => (
                <li key={title}>
                  <span>0{index + 1}</span>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="landing-final-cta" aria-labelledby="final-cta-title">
          <div className="landing-shell landing-final-cta-inner">
            <p>Frely</p>
            <h2 id="final-cta-title">下一位中转站主人，<br />可以是你。</h2>
            <a className="landing-primary-cta landing-primary-cta-light" href={loginHref}>
              <span>登录并进入控制台</span>
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-shell">
          <span>© Frely</span>
          <span>Team-owned AI relay infrastructure</span>
        </div>
      </footer>
    </div>
  );
}

function DomainLanding({ data }: { data: Extract<HomePageData, { kind: "domain" }> }) {
  return (
    <main className="landing-page" lang="en">
      <section className="landing-final-cta">
        <div className="landing-shell landing-final-cta-inner">
          <p>Frely</p>
          <h1>{data.teamName}</h1>
          <p>Access your Team workspace and model relay.</p>
          <form method="post" action={data.action}>
            <input type="hidden" name="state" value={data.state} />
            <button className="landing-primary-cta landing-primary-cta-light" type="submit">
              Log in{data.registrationAvailable ? " or register" : ""}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
