import { loadConfig } from '../src/corsa-mock/config';

test('The timeout failure mode waits 25 seconds by default', () => {
  expect(loadConfig({}).failure.timeoutMs).toBe(25000);
});
