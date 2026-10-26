<?php
// SPDX-License-Identifier: Apache-2.0
declare(strict_types=1);

namespace App\Jobs;

use App\Services\Nocustody\NocustodyClient;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Acts on a recorded gateway event. The invoice is re-read from the API before anything is granted, so the decision
 * never rests on the webhook body alone. Replace the marked lines with your own order logic.
 */
final class HandleNocustodyEvent implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;

    public int $tries = 10;

    public function __construct(public readonly string $eventId)
    {
    }

    public function backoff(): array
    {
        return [10, 30, 60, 300];
    }

    public function handle(): void
    {
        $event = DB::table('nocustody_events')->where('event_id', $this->eventId)->first();
        if ($event === null || $event->processed_at !== null) {
            return;
        }
        $type = $event->type;
        if (str_starts_with($type, 'invoice.')) {
            $invoice = NocustodyClient::fromConfig()->getInvoice($event->object_id);
            $orderId = (string) $invoice['merchant_order_id'];
            DB::table('nocustody_invoices')
                ->where('invoice_id', $invoice['id'])
                ->update(['status' => $invoice['status'], 'updated_at' => now()]);

            // A paid invoice moves through aml_pending to completed in the same cycle, so paid / overpaid / paid_late
            // are event types you receive, not statuses you read back. Decide "needs a person" by the event type and
            // grant access only when the re-read invoice says completed.
            if (in_array($type, ['invoice.underpaid', 'invoice.overpaid', 'invoice.paid_late', 'invoice.aml_hold'], true)) {
                // YOUR CODE: needs a human — notify support with $orderId, $type and the amounts in $invoice
                // (received versus payment.amount). Refunds are manual, from your own wallet.
                Log::warning('nocustody: invoice needs attention', ['order' => $orderId, 'event' => $type]);
            }
            if ($invoice['status'] === 'completed') {
                // YOUR CODE: grant access for $orderId exactly once (e.g. inside a transaction, guarded by order state).
                Log::info('nocustody: order paid', ['order' => $orderId, 'invoice' => $invoice['id']]);
            }
        } elseif ($type === 'transfer.unmatched') {
            // A payment that matched no invoice (wrong amount, no memo, too late): resolve it manually.
            Log::warning('nocustody: unmatched transfer', ['event' => $this->eventId]);
        }
        DB::table('nocustody_events')->where('event_id', $this->eventId)->update(['processed_at' => now()]);
    }
}
