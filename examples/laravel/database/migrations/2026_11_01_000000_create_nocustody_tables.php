<?php
// SPDX-License-Identifier: Apache-2.0
declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Which gateway invoice belongs to which order.
        Schema::create('nocustody_invoices', function (Blueprint $table) {
            $table->id();
            $table->string('order_id', 128)->unique();
            $table->string('invoice_id', 64)->unique();
            $table->string('asset', 64);
            $table->string('status', 32);
            $table->timestamps();
        });

        // Every accepted webhook event, once: the unique event_id absorbs repeated deliveries.
        Schema::create('nocustody_events', function (Blueprint $table) {
            $table->id();
            $table->string('event_id', 64)->unique();
            $table->string('type', 64);
            $table->string('object_id', 128);
            $table->json('payload');
            $table->timestamp('received_at');
            $table->timestamp('processed_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('nocustody_events');
        Schema::dropIfExists('nocustody_invoices');
    }
};
