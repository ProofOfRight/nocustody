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
 * never rests on the webhook body alone. The same event may be queued more than once (redelivery, the sweeper in
 * routes/nocustody-console.php): the event row is locked and checked inside the transaction that does the work and
 * marks it processed, so the work happens once. Replace the marked lines with your own order logic.
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
        // Read the invoice before the transaction: no row lock is held during the HTTP call.
        $invoice = str_starts_with($event->type, 'invoice.')
            ? NocustodyClient::fromConfig()->getInvoice($event->object_id)
            : null;

        DB::transaction(function () use ($invoice): void {
            $event = DB::table('nocustody_events')->where('event_id', $this->eventId)->lockForUpdate()->first();
            if ($event === null || $event->processed_at !== null) {
                return; // another worker got there first
            }
            if ($invoice !== null) {
                $orderId = (string) $invoice['merchant_order_id'];
                DB::table('nocustody_invoices')
                    ->where('invoice_id', $invoice['id'])
                    ->update(['status' => $invoice['status'], 'updated_at' => now()]);

                if ($invoice['status'] === 'completed') {
                    // YOUR CODE: grant access for $orderId here, in this transaction, guarded by the order's state.
                    Log::info('nocustody: order paid', ['order' => $orderId, 'invoice' => $invoice['id']]);
                } elseif (in_array($invoice['status'], ['underpaid', 'overpaid', 'paid_late', 'aml_hold'], true)) {
                    // YOUR CODE: needs a human — notify support with $orderId and the amounts in $invoice.
                    Log::warning('nocustody: invoice needs attention', ['order' => $orderId, 'status' => $invoice['status']]);
                }
            } elseif ($event->type === 'transfer.unmatched') {
                // A payment that matched no invoice (wrong amount, no memo, too late): resolve it manually.
                Log::warning('nocustody: unmatched transfer', ['event' => $this->eventId]);
            }
            DB::table('nocustody_events')->where('event_id', $this->eventId)->update(['processed_at' => now()]);
        });
    }
}
