<?php
// SPDX-License-Identifier: Apache-2.0
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Jobs\HandleNocustodyEvent;
use App\Services\Nocustody\WebhookSignature;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;

/**
 * Receives gateway events: verifies the signature over the raw body, records each event id once (delivery is
 * at-least-once), queues the work and answers 204 quickly. Anything other than 2xx makes the gateway retry.
 */
final class NocustodyWebhookController
{
    public function __invoke(Request $request): Response
    {
        $event = WebhookSignature::verify(
            (string) config('nocustody.webhook_secret'),
            $request->getContent(),
            $request->header('X-Signature'),
            $request->header('X-Timestamp'),
            $request->header('X-Event-Id'),
            time(),
            (int) config('nocustody.webhook_tolerance', 300),
        );
        if ($event === null) {
            return response('', 400);
        }

        // The unique index on event_id makes a repeated delivery a no-op.
        $inserted = DB::table('nocustody_events')->insertOrIgnore([
            'event_id' => $event['id'],
            'type' => (string) ($event['type'] ?? ''),
            'object_id' => (string) ($event['data']['object_id'] ?? ''),
            'payload' => json_encode($event, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            'received_at' => now(),
        ]);
        if ($inserted === 1) {
            HandleNocustodyEvent::dispatch($event['id']);
        }
        return response('', 204);
    }
}
