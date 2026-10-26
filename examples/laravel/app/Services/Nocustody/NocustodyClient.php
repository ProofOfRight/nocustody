<?php
// SPDX-License-Identifier: Apache-2.0
declare(strict_types=1);

namespace App\Services\Nocustody;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\Http;

/** Merchant API client on Laravel's HTTP client. Amounts are decimal strings, never floats. */
final class NocustodyClient
{
    public function __construct(
        private readonly string $apiUrl,
        private readonly string $apiKey,
        private readonly int $timeout = 10,
    ) {
    }

    public static function fromConfig(): self
    {
        return new self(
            rtrim((string) config('nocustody.api_url'), '/'),
            (string) config('nocustody.api_key'),
            (int) config('nocustody.timeout', 10),
        );
    }

    /**
     * Creates an invoice for an order. Safe to retry: the order id is also the idempotency key, and the gateway
     * returns the existing invoice for an order it already knows.
     *
     * @throws RequestException
     */
    public function createInvoice(string $orderId, string $amount, string $currency, string $asset): array
    {
        return $this->http()
            ->withHeaders(['Idempotency-Key' => 'order-' . $orderId])
            ->post('/v1/invoices', [
                'merchant_order_id' => $orderId,
                'price' => ['amount' => $amount, 'currency' => $currency],
                'asset' => $asset,
            ])
            ->throw()
            ->json();
    }

    /** @throws RequestException */
    public function getInvoice(string $invoiceId): array
    {
        return $this->http()->get('/v1/invoices/' . rawurlencode($invoiceId))->throw()->json();
    }

    /** Absolute URL of the hosted payment page for an invoice, or null if the page is disabled. */
    public static function paymentPageUrl(array $invoice, ?string $lang = null): ?string
    {
        $path = $invoice['payment']['page'] ?? null;
        $origin = config('nocustody.public_url');
        if (!is_string($path) || !is_string($origin) || $origin === '') {
            return null;
        }
        return rtrim($origin, '/') . $path . ($lang !== null ? '?lang=' . rawurlencode($lang) : '');
    }

    private function http(): PendingRequest
    {
        return Http::baseUrl($this->apiUrl)
            ->withToken($this->apiKey)
            ->acceptJson()
            ->timeout($this->timeout)
            ->withoutRedirecting();
    }
}
