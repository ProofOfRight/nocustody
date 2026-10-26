<?php
// SPDX-License-Identifier: Apache-2.0
// Add to routes/web.php (or require this file from it). The webhook is called by the gateway, not by a browser,
// so it has no CSRF token: exclude it from CSRF verification.

use App\Http\Controllers\NocustodyWebhookController;
use App\Services\Nocustody\NocustodyClient;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::post('/nocustody/webhook', NocustodyWebhookController::class)
    ->withoutMiddleware([ValidateCsrfToken::class]);

// Checkout: create (or fetch the existing) invoice for an order and send the payer to the hosted payment page.
// Replace the order lookup with your own; price and currency must come from your order, never from the request.
Route::post('/orders/{order}/pay/crypto', function (Request $request, string $order) {
    $asset = $request->validate(['asset' => 'required|in:usdt-tron,usdt-ton'])['asset'];
    $price = ['amount' => '9.99', 'currency' => 'USD']; // YOUR CODE: from the order

    $invoice = NocustodyClient::fromConfig()->createInvoice($order, $price['amount'], $price['currency'], $asset);
    DB::table('nocustody_invoices')->upsert(
        [['order_id' => $order, 'invoice_id' => $invoice['id'], 'asset' => $asset, 'status' => $invoice['status'],
          'created_at' => now(), 'updated_at' => now()]],
        ['order_id'],
        ['invoice_id', 'asset', 'status', 'updated_at'],
    );

    // The page speaks en, ru, fr, fa and zh-CN; Laravel locales use "_" (zh_CN).
    $url = NocustodyClient::paymentPageUrl($invoice, str_replace('_', '-', app()->getLocale()));
    return $url !== null ? redirect()->away($url) : response()->json($invoice['payment']);
})->middleware('auth');
