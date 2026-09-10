export function createFixtureTransport(fixture, { variant, sessionId } = {}) {
  let cursor = 0;
  const log = [];
  return {
    call(request = {}) {
      const response = structuredClone(fixture.responses?.[cursor] ?? {
        status: "error",
        error: "fixture_response_exhausted",
      });
      const capability = request.capability ?? fixture.request?.capability ?? response.capability ?? null;
      log.push({
        fixture_id: fixture.fixture_id,
        fixture_hash: fixture.content_hash,
        variant: variant ?? null,
        session_id: sessionId ?? null,
        attempt_index: cursor,
        capability,
        params: structuredClone(request),
        status: response.status ?? "unknown",
        http_status: response.http_status ?? null,
        error: response.error ?? null,
        response: structuredClone(response),
      });
      cursor += 1;
      return response;
    },
    events() {
      return structuredClone(log);
    },
  };
}

export function validateFixtureTrace(fixture, events, { maxCalls = Infinity, expectedSessionId } = {}) {
  const failures = [];
  const attempts = events ?? [];
  const expected = fixture.responses ?? [];
  if (attempts.length > Number(maxCalls)) failures.push("call_budget_exceeded");
  if (attempts.length !== expected.length) failures.push("response_sequence_incomplete");
  if (attempts.length > expected.length) failures.push("retry_limit_exceeded");
  if (attempts.some((event) => event.capability && !String(event.capability).startsWith("qveris_finance."))) failures.push("non_canonical_capability");
  if (expectedSessionId != null && attempts.some((event) => event.session_id !== expectedSessionId)) failures.push("cross_session_reuse");
  const indexes = attempts.map((event) => event.attempt_index);
  if (indexes.some((value, index) => value !== index)) failures.push("attempt_order_invalid");
  for (let index = 0; index < Math.min(attempts.length, expected.length); index += 1) {
    const event = attempts[index];
    const response = expected[index];
    const expectedCapability = response.capability ?? fixture.request?.capability ?? null;
    if (event.fixture_id !== fixture.fixture_id || event.fixture_hash !== fixture.content_hash) failures.push("fixture_identity_mismatch");
    if (expectedCapability && event.capability !== expectedCapability) failures.push("call_order_invalid");
    if (event.status !== response.status || event.http_status !== (response.http_status ?? null) || event.error !== (response.error ?? null)) {
      failures.push("response_shape_mismatch");
    }
  }
  return {
    passed: failures.length === 0,
    failures: [...new Set(failures)],
    attempt_count: attempts.length,
    expected_attempt_count: expected.length,
    decision_reason_expected: fixture.expected_reason_code ?? null,
  };
}
