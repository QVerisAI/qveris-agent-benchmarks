# Persona-Weighted Lift: Turning Quality–Cost Exchange Rates into Deployment Verdicts for Tool-Augmented Agents

**Linfang Wang**

*Draft, 2026-07-13. Full section pass (§1–§8). Citations are placeholder-keyed pending a bibliography pass.*

> Anonymization: the evaluated system — a commercial finance data-and-tool gateway offered as both a CLI and an MCP server — is referred to throughout as **the gateway** (with its two access forms **gateway-CLI** and **gateway-MCP**), and the control condition without it as the **baseline**.

## Abstract

Quality-only "lift" — the score delta a tool or scaffold buys a baseline agent — systematically overstates the value of tool-augmented agents, because it ignores the latency and token cost spent to earn that delta. Cost-aware leaderboards answer this by plotting a quality×cost Pareto frontier, but a frontier *describes* the trade-off without *deciding* it. The missing element is an **exchange rate** between quality points and resource cost — a borrowed idea (the willingness-to-pay threshold of cost-effectiveness analysis), which is not universal but **decision-maker-specific**, here **persona-specific**. We present *persona-weighted lift*: declared per-persona weights that convert a quality delta and its measured resource deltas into a single wins/wash/loses verdict, bundled with three companion instruments (iso-cost budget-matched runs, dual-track scoring, iso-quality cost-per-pass) and a task-clustered statistical layer, all released in an open benchmark harness. On a 30-task expert-validated finance benchmark, the gateway's quality lift is real, robust across seeds and scoring layers, and statistically significant (task-clustered CIs excluding zero). Our central empirical result is that **the deployment verdict is determined not by the tool but by how its cost is counted**: on a cache-heavy runtime where 84–86% of the tool's input tokens are prefix-cache reads, pricing those re-reads at the full input rate (a token-proxy cost) makes all six persona×access-form cells *lose or wash*, while pricing them correctly (cache-aware dollars) makes all six *win* — the tool's billable uncached input is actually *below* the baseline's. The economic verdict flips on the cost caliber alone. We argue this makes cost, and therefore the verdict, a property of the *(tool, policy)* pair rather than the tool, and that any cost-aware agent verdict must declare its cost accounting to be reproducible.

---

## 1. Problem

A tool-augmented agent — one given web search, a code sandbox, a retrieval index, or a data-API gateway — is evaluated against a baseline agent without that tool. The headline number is **lift**: the quality-score delta. Lift is seductive because it is a single positive number that says "the tool helped." It is also misleading, because the tool bought that help with resources the baseline did not spend: more tool calls, more tokens re-billed through the agent's context each turn, more wall-clock latency. A tool that raises quality by 6 points while quadrupling token cost is not obviously worth deploying, and "lift +6" does not say whether it is.

The now-standard correction, from *AI Agents That Matter* [Kapoor et al. 2024] and the Holistic Agent Leaderboard [Kapoor et al. 2025], is to stop reporting accuracy alone and plot the **cost×quality Pareto frontier**. This is a real advance: it exposes that many "state-of-the-art" agents are Pareto-dominated by trivial retry baselines. But a frontier is a description, not a decision. When two arms both sit on the frontier — one higher-quality-higher-cost, one lower-both — the frontier is silent on which to ship. The practitioner supplies the missing input every time they choose: an **exchange rate** between quality and cost.

That exchange rate has two properties that a frontier plot elides. First, it is **explicit and declarable**: a deploying organization can state how many quality points it will pay for a 1% increase in latency or spend, and once stated, the "worth it?" question becomes arithmetic. Second, it is **not universal**. The same +6 quality points at +300% token cost is a clear win for a research analyst who runs a handful of deep queries a day and a clear loss for an overnight batch scoring millions of documents. A single scalar verdict is wrong; a small set of **persona-conditioned** verdicts is right.

None of this decision theory is new, and we are explicit about that (§6). The exchange rate between an outcome and its cost is the willingness-to-pay threshold λ of cost-effectiveness analysis; "adjusted benefit = quality − Σ weight·cost" is its Net Health Benefit; decision-makers who price resources differently trace a cost-effectiveness acceptability curve; and weighted scalarization of competing objectives is standard multi-objective optimization, recently applied to agent scoring with application-specific weights by CLEAR [Mehta 2025]. Our contribution is not the decision theory but its **operationalization for agent evaluation**: applying pre-declared, per-persona exchange rates to a *paired A/B tool-ablation* lift to emit a per-persona verdict, packaged with iso-cost, dual-track, and iso-quality cost-per-pass as one reproducible protocol, and reported with task-clustered statistical inference.

We then report a result that we did not anticipate and that reframes what a cost-aware verdict even means. On our benchmark, the persona verdict is not decided by the tool's behavior at all — it is decided by **how the tool's cost is counted**. Modern agent runtimes cache the prefix of each turn's context aggressively; on our primary batch, 84–86% of the gateway's input tokens are cache reads, billed at roughly a tenth of the full input rate. The naive "token-proxy" cost — total input tokens, the axis a Pareto-frontier or cost-of-pass analysis reads by default — counts those cheap re-reads at full price and reports the gateway as ~4.6× more expensive than the baseline, which drives every persona verdict negative. The cache-aware dollar cost — pricing cache reads at their real discounted rate — reports the same runs as 1.5× more expensive, and flips every persona verdict to positive. The tool did not change; the accounting did. This is the paper's central empirical exhibit (§4), and it carries a general lesson: **a cost-aware agent verdict is only as trustworthy as its cost accounting, and that accounting is a property of the agent's runtime policy, not of the tool.**

## 2. Method

We operationalize the exchange-rate idea as **persona-weighted lift** and three companion instruments, implement them in an open benchmark harness, and (§3) validate on a finance agent benchmark where a data-and-tool gateway is measured against a web-search baseline.

### 2.1 Persona-weighted lift (core)

Let `Δq` be the quality lift (points, 0–100 scale) and `Δℓ`, `Δc` the observed latency and cost deltas as percentages of baseline. A **persona** `p` declares two weights, `w^ℓ_p` and `w^c_p`, each read as "quality points I am willing to give up per 1% increase in this resource." The **persona-adjusted lift** is

```
Δ̃q_p = Δq − w^ℓ_p · (Δℓ / 100) − w^c_p · (Δc / 100),
```

and the **verdict** is `wins` if `Δ̃q_p > τ`, `loses` if `Δ̃q_p < −τ`, else `wash`, for a tie band `τ` (we use 1 point). We fix three personas:

| Persona | `w^ℓ` (latency) | `w^c` (cost) | Reading |
|---|---|---|---|
| Interactive analyst | 10 | 2 | Latency-critical; a human waits on each answer |
| Daily research | 3 | 2 | Moderate on both; a handful of deep queries |
| Overnight batch | 0 | 5 | Latency-indifferent, cost-dominated |

Readers from decision analysis will recognize `Δ̃q_p` as the **Net Health Benefit** [Stinnett & Mullahy 1998] with `w = 1/λ` (λ the willingness-to-pay per resource unit), and the three personas as three points on a **cost-effectiveness acceptability curve** [Fenwick et al. 2001]. We adopt this machinery deliberately rather than reinvent it; the novelty is its use as a paired-A/B tool-ablation verdict. The weights are a **versioned, declared artifact** (`personas-2026-07-04`), not fitted to the data — the method's central honesty commitment and its central limitation (§7): the exchange rate is an input a deploying organization should set from its own economics, and we ship defaults, not truths. What the method guarantees is that *whatever* rate is chosen, it is explicit, auditable, and applied uniformly — so two readers who disagree can locate their disagreement in one number instead of arguing about a frontier plot.

Two design choices make the verdict robust rather than brittle. First, `Δq` is a **paired** quantity: the same task, same scoring, run with and without the tool, so the lift differences out task difficulty and prompt variance. Second, the resource deltas are **percentages of baseline**, so the exchange rate is scale-free — a weight of 2 on cost means the same thing whether the baseline spends a cent or a dollar.

The cost axis `Δc` is the pivot of the whole method, and §4 shows it is not a settled quantity: the same runs admit a **token-proxy** cost (total input tokens, ignoring caching) and a **cache-aware dollar** cost (pricing cache reads at their discounted rate), and the two can put a persona on opposite sides of `τ`. We therefore report the verdict on both axes and treat the cache-aware axis as the deployment-truth primary. Because the harness emits the verdict natively from per-cell resource means, both axes are reproducible outputs, not hand computations.

### 2.2 Iso-cost budget-matched runs

The exchange-rate verdict answers "is the extra quality worth the extra cost." A dual question is "at *equal* cost, who is better." Iso-cost mode caps every arm at the same per-task budget (tokens or dollars) and compares quality under the cap — turning off the tool's cost advantage/disadvantage and isolating capability-per-dollar. This is the budget-matched analog of the frontier: instead of comparing at each arm's natural operating point, compare at a shared one. It answers the procurement question a frontier cannot: "if I fix my spend, which agent delivers more?"

### 2.3 Dual-track scoring

A tool can fail for two very different reasons: the *capability* is wrong (the agent used the tool and still answered badly), or the *infrastructure* failed (the tool call errored, timed out, or was unavailable). Conflating them punishes a good tool for a flaky deployment. We therefore score two tracks: **raw end-to-end** (every failure counts, the deployment-as-is number) and **healthy-capability** (infrastructure-blocked rows excluded, the capability-ceiling number). Reporting both prevents a transient outage from masquerading as a quality deficit and vice versa; the gap between the tracks is itself a deployment-reliability signal.

### 2.4 Iso-quality cost-per-pass

Complementary to the exchange-rate verdict, we report the dollar cost of one *correct* answer (cost-of-pass style [Erol et al. 2025]): a variant that fails often can cost more per pass than an expensive one that rarely retries. This is a single-objective, persona-agnostic companion metric — "cheapest correct answer" — that we report alongside the multi-resource, persona-conditioned verdict rather than in place of it.

### 2.5 Statistical inference layer

Persona verdicts are differences of differences and are at least as noisy as lift, so they must carry the same statistical apparatus. We take the **task**, not the task-trial row, as the unit of inference: trials of one task are correlated, and treating rows as independent inflates the effective sample size and shrinks intervals spuriously. We report task-clustered paired-difference 95% confidence intervals (paired-t, `df = k_tasks − 1`) corroborated by a seeded hierarchical bootstrap (resampling tasks, then trials within task and arm), the within-task standard deviation and ICC(1) as consistency measures, and the minimum detectable effect (MDE) at 80% power for the given task count and spread — so a report states not only the lift but the smallest lift its design could have detected. The layer follows the agent-evaluation-statistics literature [Miller 2024].

## 3. Case study: a finance data-and-tool gateway

### 3.1 Setup

The benchmark comprises **30 finance tasks** across five workflow families — announcement summarization, anomaly detection, market-data dashboards, event monitoring, and multi-source investment integration — each requiring an agent to retrieve real 2025/2026 data and produce a structured, source-cited answer. Every task's acceptance standard was written and cross-validated by domain experts over four questionnaire rounds (majority fusion with recorded dissent and adjudication); the 30 tasks reported here are the fully expert-validated set. Each task is run under three arms — **baseline** (public web search only), **gateway-CLI**, and **gateway-MCP** — for **3 trials**, giving 270 graded runs on a single control agent (a GPT-5.5-class model at high reasoning effort), holding the agent, prompts, and scoring identical so the only variable is tool access.

Answers are scored on a 5-dimension, 100-point rubric (accuracy, source trust, usability, efficiency, cleanliness) by a **dual layer**: a deterministic rule layer and an independent LLM judge, with the reported score `min(rule, judge)` — the judge caps rule-layer over-crediting, the rule layer floors judge leniency. The rule layer's accuracy heuristic was hardened against digit/keyword stuffing after adversarial review, and a contamination scan (denylist plus 12-word golden/task fingerprints) over all 270 runs returned **zero hard and zero weak hits**. Rows are graded on two tracks (raw end-to-end and healthy-capability, §2.3); the batch had **zero infrastructure-blocked rows**, so the two tracks coincide.

### 3.2 Quality lift is real, significant, and not carried by one task

On the primary (judged) lens, the gateway lift is **+7.4 points for gateway-CLI (95% CI [3.9, 10.9])** and **+8.0 for gateway-MCP (CI [4.6, 11.4])**, both with 95% CIs excluding zero and an MDE (4.9 / 4.8) comfortably below the observed lift — the design is powered to detect the effect it reports. The conservative rule-layer floor is +6.5 / +4.5, also significant. The lift is directionally near-unanimous across tasks: **27 of 30 tasks are positive for gateway-CLI, 26 of 30 for gateway-MCP**; it is not an artifact of one favorable task. A prior 15-task locked baseline on an earlier runtime shows the same pattern at larger magnitude (+11.9 / +13.5), so the direction is stable across two independent batches.

### 3.3 Value concentrates where reliable multi-source data matters

Stratifying by task time-sensitivity — T1 live-fetch (retrieve a current number), T2 historical lookup (retrieve and extract disclosed data), T3 complex investigation (multi-step, cross-source) — locates the value precisely. Both **T2 (n=12: +8.3 / +9.4)** and **T3 (n=11: +6.0 / +6.9)** are individually significant; **T1 (n=7: +8.1 / +7.3)** carries a high point estimate but a zero-crossing interval — live single-number fetches are inherently high-variance and the gateway's marginal value there is least distinguishable. The T3 stratum is a methodological aside worth stating: at the 15-task batch it held only 3 tasks and its interval crossed zero; expanding the validated set to 11 T3 tasks moved it to significance — a concrete instance of MDE-driven design growth (§2.5), not a change in the underlying effect.

### 3.4 The tool also stabilizes output

Quality and stability are independent claims. The gateway arms are markedly more consistent trial-to-trial: within-task score standard deviation falls from **7.7 (baseline) to 5.3 (gateway-CLI) to 4.2 (gateway-MCP)** — roughly a 1.5–1.8× reduction in output variance. For a deliverable-facing deployment, "more stable" is a distinct and valuable property from "higher on average," and the exchange-rate verdict (which reads means) does not capture it; we report it separately.

### 3.5 Measurement fidelity can move the verdict more than sampling noise

A cost-aware verdict is only as sound as the quality measurement it weighs, and we have a clean demonstration of how fragile that can be. Re-scoring an earlier batch against an *expert-revised* golden set — with cost and latency held exactly constant — moved the baseline mean down ~5.9 points (the gateway arms barely moved) and therefore the lift from +5.7/+5.3 to **+11.6/+9.8**, flipping the daily-research persona from *loses* to *wins*. The business verdict moved because the *quality definition* improved, not because anything about the tool or its cost changed. The magnitude is the point: this single definitional revision moved the lift by **1.2–1.4× the full half-width of the three-seed sampling interval** — i.e. more than random seeds do. In a domain with contested endpoints, definitional uncertainty can exceed sampling uncertainty, and a verdict reported with sampling error bars alone understates its true instability. Two lessons follow: the exchange-rate method is sensitive to precisely the right input (quality-measurement fidelity) and rewards investment in it; and any benchmark that publishes persona verdicts must publish its golden-validation provenance beside them, or the verdict is unfalsifiable.

## 4. Central exhibit: cost accounting determines the verdict

The single most consequential finding in this work is not the sign of the lift but the fragility of the cost against which the lift is weighed. On a modern, cache-aggressive agent runtime, the naive token-count cost — the axis a Pareto-frontier or cost-of-pass analysis reads by default — over-states the tool's real cost by roughly 4×, and that over-statement is enough to invert every persona verdict.

### 4.1 The setup: a cache-heavy runtime

Our primary batch (§3) runs 30 tasks × 3 trials × 3 arms (baseline, gateway-CLI, gateway-MCP) on a control agent whose runtime caches the prefix of each turn's context. Each tool result the gateway returns is re-billed as input context on every subsequent turn, so the raw input-token counts are large: per task, the baseline averages 269k input tokens, gateway-CLI 1,233k (×4.6), gateway-MCP 1,289k (×4.8). Read naively, the gateway looks 4–5× more expensive.

But the raw count conflates two token classes with a ~10× price gap. Modern APIs bill a **cache read** — a token served from a previously-cached prefix — at roughly 10% of the full input rate (a discount consistent across the major providers we checked in 2026), while **uncached** input pays full price. Extracting the cache breakdown from the runtime's per-turn usage records shows the two arms are dominated by cache reads: 86% of gateway-CLI's input tokens and 84% of gateway-MCP's are cache reads, versus only 30% for the baseline. The baseline's smaller total is mostly *fresh* search results paid at full price; the gateway's huge total is mostly *cheap re-reads*.

The consequence is counter-intuitive and central: the gateway's **uncached, full-price input is 170k tokens/task — 0.91× the baseline's 187k.** The gateway, whose raw token count is 4.6× the baseline's, pays full price on *fewer* tokens than the baseline does. Priced at deployment-realistic model rates (GPT-5.5-class: input \$5/1M, output \$30/1M, cache read 0.10×) plus the gateway's per-call API fee, the real cost figures are: baseline \$1.36/task, gateway-CLI \$2.01 (×1.48), gateway-MCP \$2.24 (×1.65). The true overhead is 1.5–1.7×, not 4.6×.

### 4.2 The flip: same runs, opposite verdicts

Feeding these deltas into the persona-weighted verdict (§2.1) on the two cost axes yields the exhibit. Latency delta is shared (gateway-CLI +32%, gateway-MCP +12%); only the cost axis differs.

| Persona | token-proxy axis (Δc ≈ +360% / +380%) | cache-aware $ axis (Δc ≈ +48% / +65%) |
|---|---|---|
| Interactive analyst | −3.0 loses / −0.8 wash | **+3.2 wins / +5.5 wins** |
| Daily research | −0.7 wash / +0.0 wash | **+5.5 wins / +6.3 wins** |
| Overnight batch | −10.6 loses / −11.0 loses | **+5.0 wins / +4.7 wins** |

On the token-proxy axis — which prices the 84–86% cache reads at full rate — all six persona×access-form cells are negative or a wash; the cost-dominated overnight-batch persona loses by double digits. On the cache-aware dollar axis, all six win, and even the cost-sensitive overnight persona clears the tie band by +4.7 or more. **The tool, the tasks, the quality scores, and the latency are identical across the two columns; only the cost accounting changed, and it reversed the deployment decision.** A practitioner who reads the default token-proxy cost would reject a tool that, correctly costed, is worth deploying for every profile they run.

### 4.3 The gap is rate-invariant; only tie-band cells move

The reversal is not an artifact of our chosen prices. The qualitative gap — token-proxy strongly negative, cache-aware clearly positive — is driven by the ~10× read/write price ratio and the 84–86% cache-hit rate, both structural, and holds across any plausible pricing. What *does* move with pricing is the position of individual cells relative to the tie band `τ`: under illustrative flat rates (input \$1, output \$3) the cost-sensitive overnight/gateway-MCP cell sits at a wash rather than a win, whereas under deployment-realistic GPT-5.5 rates it wins with margin (the high output price raises the baseline's own cost, shrinking the gateway's relative overhead). We report the tie-band cells as pricing-sensitive and instruct that an acceptance verdict be computed at the deployed model's real rates; the axis-level conclusion is robust regardless.

### 4.4 Why this makes cost a property of the (tool, policy) pair

The flip is a special case of a general point. A tool's output is billed once when produced, then re-billed as input context on every subsequent turn until the trajectory ends, so its marginal token cost is `c₀(τ)·(1 + A(π, t_τ))`, where the **amplification factor** `A` is the expected re-billed footprint of the tool's output over the remaining trajectory under agent policy π — discounted, under prefix caching, by the uncached re-bill fraction. Because `A` depends on the policy (how many turns follow, and how cache-friendly the agent is), the cost term — and therefore the verdict — is a property of *(tool, policy)*, not of the tool alone. Our two arms make this concrete: the gross re-billing is real and drives the 4.6× raw token counts, but the *billable* amplification is small precisely because the runtime's aggressive prefix caching discounts the re-reads, which is why the cache-aware overhead collapses to 1.5×. A less cache-friendly runtime would show a larger billable amplification and could sit closer to the token-proxy picture. We therefore report verdicts as **conditional on the evaluated runtime, not universal**, and note that `A` is estimable from trajectory logs by amortizing each tool call's output over its uncached downstream footprint. This policy-conditionality is not unique to our method: any cost-aware verdict (Pareto-frontier, cost-of-pass, CLEAR) inherits it, and most report tool cost as if it were policy-free. The methodological demand that follows is simple and, we argue, non-negotiable for reproducibility: **a cost-aware agent verdict must declare its cost accounting — the read/write cache prices and the caching regime — or it is not reproducible across runtimes.**

*(A formal treatment — when do tool cost-effectiveness rankings transfer across policies, and a proof that they generically do not — is a separate, higher-risk decision-theoretic result we develop elsewhere; here it is a bounded caveat with a named, measurable factor.)*

## 5. Sensitivity and comparisons

**Verdict stability under rate perturbation.** Because the verdict is `Δq − Σ w·Δr`, its sensitivity to each weight is exactly `Δr` (the resource delta), so a verdict near the tie band is fragile in whichever resource is largest. We report, per cell, the resource delta that flips the verdict — a closed-form acceptance target rather than a judgment call. On the cache-aware axis the current margins are wide (overnight-batch clears by +4.7), so no cell is one small repricing away from flipping; on the token-proxy axis the same arithmetic yields the cost-reduction target a runtime would have to hit for each persona to turn positive. "How far must cost fall to make persona P win" is thus an arithmetic question the method answers directly.

**Versus Pareto-dominance.** On the same data a Pareto-frontier analysis reports that the gateway arms are neither dominated by nor dominant over the baseline (higher quality, higher cost) and stops — it cannot say whether to ship. The persona verdict resolves exactly this indeterminacy by supplying the missing exchange rate, and does so per user profile rather than as a single scalar.

**Versus cost-of-pass.** The iso-quality cost-per-pass companion (§2.4) prices one correct answer and is single-objective (dollars, no latency) and persona-agnostic. It answers "cheapest correct answer"; persona-weighted lift answers "worth it for user P." We report both; they are complementary, not substitutes.

**Single-run verdicts are unstable.** An earlier single-trial run scored the daily-research persona as *wash*; three seeds moved it to *loses*; expert validation then moved it to *wins*. Only one of those three transitions is a real change in the world (the golden revision); the wash→loses step was sampling noise made legible only by seeds and CIs. Persona verdicts, being differences of differences, must be reported with the statistical apparatus of §2.5, not from a single run.

## 6. Related work and honest lineage

**The formalism is not new, and we do not claim it is.** The exchange rate between an outcome and its cost is the willingness-to-pay threshold λ of health-economics **cost-effectiveness analysis**; our persona-adjusted lift `Δ̃q = Δq − Σ w·Δr` is its **Net (Health) Benefit** with `w = 1/λ` [Stinnett & Mullahy 1998]; the cost-per-pass ratio is an **ICER**; and our three personas — three willingness-to-pay levels yielding possibly different winners — are a discretized **cost-effectiveness acceptability curve** [Fenwick et al. 2001]. Any reviewer from decision analysis will see this immediately; we surface it rather than let it read as a rediscovery under new names.

**Nearest agent-evaluation prior work.** *CLEAR / "Beyond Accuracy"* [Mehta 2025] is the closest: it scalarizes cost, latency, and quality for enterprise agents with **application-specific weights**. It differs from this work in four ways that define our contribution: its weights act on each agent's **absolute normalized levels**, not on a **paired A/B ablation delta**; it conditions on application domain, not on **latency/cost personas**; it emits a composite score and a frontier, not a **per-persona wins/wash/loses verdict**; and it does not bundle iso-cost, dual-track, and cache-aware cost accounting. *AI Agents That Matter* [Kapoor et al. 2024] and HAL [Kapoor et al. 2025] establish cost-controlled evaluation and the cost×quality Pareto frontier but deliberately stop at the frontier and emit no verdict (HAL's scaffold-effect analysis is a partial precedent for our dual-track split, which we present as good practice, not a contribution). *Cost-of-Pass* [Erol et al. 2025] is the direct ancestor of our iso-quality cost-per-pass — a single dollar-only cost-effectiveness ratio — without latency, persona, or verdict. The statistical-inference layer follows [Miller 2024].

**Anticipating the obvious objection** — *"this is Net Monetary Benefit / a CEAC with λ renamed 'exchange rate,' and CLEAR already did persona-weighted agent scoring"* — we concede both premises. The formalism is CEA; the persona-weighted-scalar idea is CLEAR's. What is not prior art, to our knowledge, is the specific package: **pre-declared, per-persona exchange rates applied to a paired A/B tool-ablation lift, emitting a per-persona wins/wash/loses verdict, bundled with iso-cost, dual-track scoring, and iso-quality cost-per-pass, reported with task-clustered inference, and — the empirical core — the demonstration that the verdict is determined by the cost-accounting caliber (cache-aware vs token-proxy), which makes the tool cost a property of the (tool, policy) pair.** The paper's weight rests on that package and on the two empirical findings — the cost-accounting flip (§4) and the measurement-fidelity result (§3.5) — not on the borrowed decision theory.

## 7. Limitations

- **The exchange rates are declared, not elicited.** We ship defaults (`personas-2026-07-04`); we do not measure any real user's willingness-to-pay. The method's value is making the rate explicit and auditable, not correct. Eliciting rates from deployment economics or a user study is the obvious next step.
- **Cost is a proxy and is policy-conditional.** Dollar figures use published per-token rates and a standard cache-read discount, not a specific billing contract; and as §4.4 argues, the cost — hence the verdict — depends on the runtime's caching policy. Verdicts are labeled by cost axis and runtime generation to prevent conflation.
- **Single domain, single control agent.** The case study is one finance benchmark on one GPT-5.5-class control agent; cross-domain and cross-agent generalization is unverified (a second-agent leg is registered future work). The method is domain- and agent-agnostic by construction, but the reported verdicts are not claimed to transfer.
- **Verdicts are point estimates near the tie band.** Cells within the tie band should be read with their flip thresholds (§5), not as hard labels.

## 8. Release

We release the persona-weighted-lift verdict, iso-cost budget mode, dual-track scoring, iso-quality cost-per-pass, cache-aware cost accounting, and the task-clustered statistical layer in an open benchmark harness, with the persona verdicts and cache-aware cost emitted as native, reproducible outputs of the aggregation pipeline (not post-hoc scripts). The versioned exchange-rate weights, the golden-validation provenance, and the per-batch cost-accounting caliber are published alongside every verdict, so a reader who disagrees with a rate, a golden, or a price can locate the disagreement in one declared artifact and recompute.

## References

- Erol, M. H., El, B., Suzgun, M., Yuksekgonul, M., & Zou, J. (2025). *Cost-of-Pass: An Economic Framework for Evaluating Language Models.* arXiv:2504.13359.
- Fenwick, E., Claxton, K., & Sculpher, M. (2001). Representing uncertainty: the role of cost-effectiveness acceptability curves. *Health Economics*, 10(8), 779–787.
- Kapoor, S., Stroebl, B., Siegel, Z. S., Nadgir, N., & Narayanan, A. (2024). *AI Agents That Matter.* arXiv:2407.01502.
- Kapoor, S., Stroebl, B., Kirgis, P., Nadgir, N., Siegel, Z. S., et al. (2025). *Holistic Agent Leaderboard: The Missing Infrastructure for AI Agent Evaluation.* arXiv:2510.11977.
- Mehta, S. (2025). *Beyond Accuracy: A Multi-Dimensional Framework for Evaluating Enterprise Agentic AI Systems* (the CLEAR framework). arXiv:2511.14136.
- Miller, E. (2024). *Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations.* arXiv:2411.00640.
- Stinnett, A. A., & Mullahy, J. (1998). Net health benefits: a new framework for the analysis of uncertainty in cost-effectiveness analysis. *Medical Decision Making*, 18(2 Suppl), S68–S80.

## Acknowledgments

We thank the five domain experts who independently reviewed and annotated the
finance benchmark's acceptance standards across four validation rounds. Their
cross-checked judgments define the Golden set on which this case study rests;
reviewer identities are withheld under the benchmark publication policy.
