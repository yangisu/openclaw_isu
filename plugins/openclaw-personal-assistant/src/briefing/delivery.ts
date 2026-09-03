import { sendDurableMessageBatch } from 'openclaw/plugin-sdk/channel-message';

import type { AlertClaim, AlertJournal } from '../state/alerts.js';

type DurableSendParams = Parameters<typeof sendDurableMessageBatch>[0];

export interface BriefingOutboundResult {
  status: 'sent' | 'suppressed' | 'partial_failed' | 'failed';
  payloadOutcomes?: Array<{ index: number; status: 'sent' | 'suppressed' | 'failed' }>;
}

export type BriefingDurableSender = (params: DurableSendParams) => Promise<BriefingOutboundResult>;

export interface BriefingDeliveryResult {
  trust: 'quoted_untrusted_data';
  allowed: boolean;
  send: false;
  delivered: boolean;
  deliveryStatus: 'sent' | 'partial' | 'failed' | 'suppressed' | 'unknown' | 'not_required';
  payloadCount: number;
  sentPayloadCount: number;
}

export async function deliverClaimedBriefing(params: {
  cfg: DurableSendParams['cfg'];
  target: string;
  claim: AlertClaim;
  alerts: Pick<AlertJournal, 'acknowledgePayloads'>;
  signal?: AbortSignal;
  send?: BriefingDurableSender;
}): Promise<BriefingDeliveryResult> {
  const { result } = params.claim;
  const payloadCount = result.messages.length;
  if (!result.send || payloadCount === 0) {
    return summary(result.allowed, false, 'not_required', payloadCount, 0);
  }

  let outbound: BriefingOutboundResult;
  try {
    outbound = await (params.send ?? sendDurableMessageBatch)({
      cfg: params.cfg,
      channel: 'telegram',
      to: params.target,
      payloads: result.messages.map(text => ({ text })),
      durability: 'required',
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    return summary(result.allowed, false, 'failed', payloadCount, 0);
  }

  const sentIndices = new Set<number>();
  for (const outcome of outbound.payloadOutcomes ?? []) {
    if (outcome.status === 'sent' && Number.isSafeInteger(outcome.index)
      && outcome.index >= 0 && outcome.index < payloadCount) {
      sentIndices.add(outcome.index);
    }
  }
  params.alerts.acknowledgePayloads(params.claim, [...sentIndices]);

  const sentPayloadCount = sentIndices.size;
  const delivered = sentPayloadCount === payloadCount;
  let deliveryStatus: BriefingDeliveryResult['deliveryStatus'];
  if (delivered) deliveryStatus = 'sent';
  else if (sentPayloadCount > 0) deliveryStatus = 'partial';
  else if (outbound.status === 'suppressed') deliveryStatus = 'suppressed';
  else if (outbound.status === 'failed') deliveryStatus = 'failed';
  else deliveryStatus = 'unknown';
  return summary(result.allowed, delivered, deliveryStatus, payloadCount, sentPayloadCount);
}

function summary(
  allowed: boolean,
  delivered: boolean,
  deliveryStatus: BriefingDeliveryResult['deliveryStatus'],
  payloadCount: number,
  sentPayloadCount: number,
): BriefingDeliveryResult {
  return {
    trust: 'quoted_untrusted_data', allowed, send: false,
    delivered, deliveryStatus, payloadCount, sentPayloadCount,
  };
}
