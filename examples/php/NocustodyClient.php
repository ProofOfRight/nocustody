<?php
// SPDX-License-Identifier: Apache-2.0
// Minimal client for the nocustody merchant API. Plain PHP 8.1+, ext-curl, no Composer packages.
declare(strict_types=1);

final class NocustodyClient
{
    public function __construct(
        private readonly string $baseUrl,   // e.g. https://pay.internal.example (behind TLS)
        private readonly string $apiKey,    // nck_..., keep it in an environment variable
        private readonly int $timeoutSeconds = 10,
    ) {
    }

    /**
     * Creates an invoice. Amounts are decimal strings, never floats.
     * Reuse the same $idempotencyKey when retrying the same order.
     */
    public function createInvoice(string $orderId, string $amount, string $currency, string $asset, string $idempotencyKey): array
    {
        return $this->request('POST', '/v1/invoices', [
            'merchant_order_id' => $orderId,
            'price' => ['amount' => $amount, 'currency' => $currency],
            'asset' => $asset,
        ], ['Idempotency-Key: ' . $idempotencyKey]);
    }

    public function getInvoice(string $id): array
    {
        return $this->request('GET', '/v1/invoices/' . rawurlencode($id));
    }

    private function request(string $method, string $path, ?array $body = null, array $headers = []): array
    {
        $ch = curl_init($this->baseUrl . $path);
        $headers[] = 'Authorization: Bearer ' . $this->apiKey;
        $headers[] = 'Accept: application/json';
        $opts = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ];
        if ($body !== null) {
            $opts[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            $headers[] = 'Content-Type: application/json';
        }
        $opts[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $opts);
        $raw = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($raw === false) {
            throw new RuntimeException('nocustody: ' . $error);
        }
        $data = json_decode((string) $raw, true, 64, JSON_THROW_ON_ERROR);
        if ($status >= 400) {
            $code = $data['error']['code'] ?? 'unknown';
            throw new RuntimeException("nocustody: HTTP $status $code");
        }
        return $data;
    }
}
