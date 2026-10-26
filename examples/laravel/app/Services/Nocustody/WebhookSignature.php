<?php
// SPDX-License-Identifier: Apache-2.0
declare(strict_types=1);

namespace App\Services\Nocustody;

/**
 * Verifies X-Signature: v1=<hex HMAC-SHA256(secret, timestamp . "." . event_id . "." . raw_body)>.
 * Plain PHP without framework dependencies, so it can be tested on its own (selftest.php).
 */
final class WebhookSignature
{
    /** Returns the decoded event, or null if anything does not match. Pass the raw body exactly as received. */
    public static function verify(
        string $secret,
        string $rawBody,
        ?string $signature,
        ?string $timestamp,
        ?string $eventId,
        int $now,
        int $toleranceSeconds = 300,
    ): ?array {
        if ($secret === '' || $signature === null || $timestamp === null || $eventId === null || !ctype_digit($timestamp)) {
            return null;
        }
        if (abs($now - (int) $timestamp) > $toleranceSeconds) {
            return null; // too old or from the future: possible replay
        }
        $expected = 'v1=' . hash_hmac('sha256', $timestamp . '.' . $eventId . '.' . $rawBody, $secret);
        if (!hash_equals($expected, $signature)) {
            return null;
        }
        try {
            $event = json_decode($rawBody, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }
        return is_array($event) && ($event['id'] ?? null) === $eventId ? $event : null;
    }
}
