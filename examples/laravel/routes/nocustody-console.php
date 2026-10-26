<?php
// SPDX-License-Identifier: Apache-2.0
// Add to routes/console.php (or require this file from it) and run the scheduler (`php artisan schedule:run` from
// cron every minute). Re-queues events that were recorded but never processed: the queue was down when the webhook
// arrived and the gateway stopped retrying, or the job used up its tries while the API was unreachable.

use App\Jobs\HandleNocustodyEvent;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schedule;

Schedule::call(function (): void {
    DB::table('nocustody_events')
        ->whereNull('processed_at')
        ->where('received_at', '<', now()->subMinutes(10))
        ->orderBy('id')
        ->limit(100)
        ->pluck('event_id')
        ->each(fn (string $id) => HandleNocustodyEvent::dispatch($id));
})->name('nocustody:requeue-events')->everyFiveMinutes()->withoutOverlapping();
