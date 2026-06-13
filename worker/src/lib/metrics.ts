/**
 * Lightweight in-memory OTLP metrics exporter for Cloudflare Workers.
 *
 * Cloudflare does not yet export Worker metrics via OTLP natively (only traces
 * and logs). This module collects counters, gauges, and histograms in memory,
 * serializes them to OTLP/JSON, and POSTs them to any OTLP-compatible endpoint
 * (e.g. Grafana Cloud).
 *
 * Note: Grafana Cloud's OTLP gateway only accepts AGGREGATION_TEMPORALITY_CUMULATIVE.
 * All counters and histograms accumulate from worker start (never reset) and
 * report cumulative totals on every flush.
 *
 * Usage:
 *   import { metrics } from '../lib/metrics';
 *   metrics.counter('http.requests_total', 1, { method: 'GET', route: '/health' });
 *   metrics.histogram('http.duration_ms', 42, { method: 'GET' });
 *   await metrics.pushAndLog('https://otlp.gateway.grafana.net/otlp', 'Basic ...', env);
 */

const SERVICE_NAME = 'construct-app-registry';
const SERVICE_VERSION = '1.0.1';

export interface MetricAttributes {
  [key: string]: string;
}

const HISTOGRAM_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface HistogramAccum {
  count: number;
  sum: number;
  rawCounts: number[];
  attributes: MetricAttributes;
}

class MetricsRegistry {
  private counters = new Map<string, { total: number; attributes: MetricAttributes }>();
  private gauges = new Map<string, { value: number; attributes: MetricAttributes }>();
  private histograms = new Map<string, HistogramAccum>();
  private hasData = false;

  counter(name: string, delta: number, attrs?: MetricAttributes): void {
    const key = this.metricKey(name, attrs);
    const existing = this.counters.get(key);
    if (existing) {
      existing.total += delta;
    } else {
      this.counters.set(key, { total: delta, attributes: attrs ?? {} });
    }
    this.hasData = true;
  }

  gauge(name: string, value: number, attrs?: MetricAttributes): void {
    const key = this.metricKey(name, attrs);
    this.gauges.set(key, { value, attributes: attrs ?? {} });
    this.hasData = true;
  }

  histogram(name: string, value: number, attrs?: MetricAttributes): void {
    const key = this.metricKey(name, attrs);
    let h = this.histograms.get(key);
    if (!h) {
      h = { count: 0, sum: 0, rawCounts: new Array(HISTOGRAM_BUCKETS.length + 1).fill(0), attributes: attrs ?? {} };
      this.histograms.set(key, h);
    }
    h.count++;
    h.sum += value;
    let bucket = HISTOGRAM_BUCKETS.length;
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
      if (value <= HISTOGRAM_BUCKETS[i]) { bucket = i; break; }
    }
    h.rawCounts[bucket]++;
    this.hasData = true;
  }

  flush(environment: string): string | null {
    if (!this.hasData) return null;

    const now = Date.now();
    const nowNano = String(BigInt(now) * BigInt(1_000_000));

    const scopeMetrics: unknown[] = [];

    // ── Counters (CUMULATIVE) ──
    const counterByName = new Map<string, { total: number; attributes: MetricAttributes }[]>();
    for (const [key, entry] of this.counters) {
      const name = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
      const existing = counterByName.get(name) ?? [];
      existing.push(entry);
      counterByName.set(name, existing);
    }
    for (const [name, entries] of counterByName) {
      scopeMetrics.push({
        name: `app_registry_${name.replace(/\./g, '_')}`,
        unit: '1',
        sum: {
          dataPoints: entries.map((e) => ({
            startTimeUnixNano: nowNano,
            timeUnixNano: nowNano,
            asDouble: e.total,
            attributes: this.attrsToOTLP(e.attributes),
          })),
          aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
          isMonotonic: true,
        },
      });
    }

    // ── Gauges ──
    const gaugeByName = new Map<string, { value: number; attributes: MetricAttributes }[]>();
    for (const [key, entry] of this.gauges) {
      const name = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
      const existing = gaugeByName.get(name) ?? [];
      existing.push(entry);
      gaugeByName.set(name, existing);
    }
    for (const [name, entries] of gaugeByName) {
      scopeMetrics.push({
        name: `app_registry_${name.replace(/\./g, '_')}`,
        unit: '1',
        gauge: {
          dataPoints: entries.map((e) => ({
            startTimeUnixNano: nowNano,
            timeUnixNano: nowNano,
            asDouble: e.value,
            attributes: this.attrsToOTLP(e.attributes),
          })),
        },
      });
    }

    // ── Histograms (CUMULATIVE, convert raw counts to cumulative) ──
    const histByName = new Map<string, HistogramAccum[]>();
    for (const [key, h] of this.histograms) {
      const name = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
      const existing = histByName.get(name) ?? [];
      existing.push(h);
      histByName.set(name, existing);
    }
    for (const [name, entries] of histByName) {
      scopeMetrics.push({
        name: `app_registry_${name.replace(/\./g, '_')}`,
        unit: 'ms',
        histogram: {
          dataPoints: entries.map((h) => {
            const cumulative = [...h.rawCounts];
            for (let i = 1; i < cumulative.length; i++) cumulative[i] += cumulative[i - 1];
            return {
              startTimeUnixNano: nowNano,
              timeUnixNano: nowNano,
              count: h.count,
              sum: h.sum,
              bucketCounts: cumulative,
              explicitBounds: HISTOGRAM_BUCKETS,
              attributes: this.attrsToOTLP(h.attributes),
            };
          }),
          aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
        },
      });
    }

    if (scopeMetrics.length === 0) {
      this.clear();
      return null;
    }

    const payload = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: SERVICE_NAME } },
            { key: 'service.version', value: { stringValue: SERVICE_VERSION } },
            { key: 'deployment.environment', value: { stringValue: environment } },
          ],
          droppedAttributesCount: 0,
        },
        scopeMetrics: [{
          scope: { name: SERVICE_NAME, version: SERVICE_VERSION },
          metrics: scopeMetrics,
        }],
      }],
    };

    this.clear();
    return JSON.stringify(payload);
  }

  async pushAndLog(endpoint: string, authHeader: string, environment: string): Promise<boolean> {
    const body = this.flush(environment);
    if (!body) return true;

    const url = `${endpoint.replace(/\/$/, '')}/v1/metrics`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader.replace(/^Authorization:\s*/i, '').trim(),
        },
        body,
      });
      if (resp.ok) {
        console.log(JSON.stringify({ source: 'metrics', level: 'info', event: 'push_ok', status: resp.status, url }));
        return true;
      }
      const errText = await resp.text().catch(() => '');
      console.warn(JSON.stringify({ source: 'metrics', level: 'warn', event: 'push_failed', status: resp.status, url, error: errText.slice(0, 500) }));
      return false;
    } catch (err) {
      console.error(JSON.stringify({ source: 'metrics', level: 'error', event: 'push_error', url, error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }

  private clear(): void {
    this.gauges.clear();
    this.hasData = this.counters.size > 0 || this.histograms.size > 0;
  }

  private metricKey(name: string, attrs?: MetricAttributes): string {
    if (!attrs || Object.keys(attrs).length === 0) return name;
    const sorted = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b));
    return `${name}:${sorted.map(([k, v]) => `${k}=${v}`).join(',')}`;
  }

  private attrsToOTLP(attrs: MetricAttributes): Array<{ key: string; value: { stringValue: string } }> {
    return Object.entries(attrs).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));
  }
}

export const metrics = new MetricsRegistry();
