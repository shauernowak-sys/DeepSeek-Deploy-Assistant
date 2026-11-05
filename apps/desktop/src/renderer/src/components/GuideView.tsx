import { useEffect } from 'react';

import type { Guide } from './guides';

export type GuideStep = Guide['steps'][number];
export type { Guide };

/** 步骤标题上方的编号 + 「第 N 步 / 共 M 步」。 */
function StepBadge({ index, total }: { index: number; total: number }): JSX.Element {
  return (
    <span className="guide-step-badge" aria-hidden="true">
      {index + 1}
      <small>/{total}</small>
    </span>
  );
}

export function GuideView({
  guide,
  step,
  onStep,
  onBack,
}: {
  guide: Guide;
  step: number;
  onStep: (index: number) => void;
  onBack: () => void;
}): JSX.Element {
  const current = guide.steps[step] ?? guide.steps[0]!;
  const total = guide.steps.length;
  // 一步一屏：切换步骤时回到顶部，用户不用往回滚去找「上一步/下一步」。
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step, guide.id]);
  return (
    <section className="guide" aria-labelledby="guide-title">
      <div className="guide-head">
        <div>
          <span className="market-section-kicker">STEP BY STEP</span>
          <h3 id="guide-title">{guide.label}</h3>
        </div>
        <button onClick={onBack}>返回</button>
      </div>

      <p className="banner">{guide.caveat}</p>

      <ol className="guide-progress" aria-label="引导步骤">
        {guide.steps.map((item, index) => (
          <li key={item.title}>
            <button
              className={index === step ? 'current' : index < step ? 'done' : ''}
              aria-current={index === step ? 'step' : undefined}
              onClick={() => onStep(index)}
            >
              <b>{index + 1}</b>
              <span>{item.title}</span>
            </button>
          </li>
        ))}
      </ol>

      <article className="guide-step" aria-live="polite">
        <h4>
          <StepBadge index={step} total={total} />
          {current.title}
        </h4>
        <p>{current.body}</p>
        {current.image !== undefined ? (
          <figure className="guide-shot">
            <img src={current.image} alt={current.imageAlt ?? current.title} />
            <figcaption>真实运行截图 · 红框与编号为说明添加，不是软件自带的高亮</figcaption>
          </figure>
        ) : (
          <div className="guide-noshot">
            这一步需要你用真实的 QQ 操作，本软件无法截取其界面，所以这里没有截图——不要把它当成已经验证。
          </div>
        )}
        <dl className="guide-facts">
          {current.where !== undefined && (
            <>
              <dt>点哪里</dt>
              <dd>{current.where}</dd>
            </>
          )}
          <dt>看到什么算完成</dt>
          <dd>{current.check}</dd>
        </dl>
        <div className="route-actions">
          <button onClick={() => onStep(Math.max(0, step - 1))} disabled={step === 0}>
            上一步
          </button>
          <button
            className="primary"
            onClick={() => onStep(Math.min(total - 1, step + 1))}
            disabled={step === total - 1}
          >
            下一步
          </button>
        </div>
      </article>
    </section>
  );
}
