<?php
// SPDX-License-Identifier: Apache-2.0
// Webhook receiver for nocustody. Plain PHP 8.1+, no Composer packages.
//   php -S 0.0.0.0:8000 webhook.php        (for local testing; use your normal web server in production)
// Environment: NOCUSTODY_WEBHOOK_SECRET; optional NOCUSTODY_WEBHOOK_LOG (file to append accepted events to).
declare(strict_types=1);

/**
 * Verifies X-Signature: v1=<hex HMAC-SHA256(secret, timestamp . "." . event_id . "." . raw_body)>.
 * Returns the decoded event or null. The raw body must be used as received — do not re-encode JSON.
 */
function nocustody_verify(string $secret, string $rawBody, ?string $signature, ?string $timestamp, ?string $eventId, int $now, int $toleranceSeconds = 300): ?array
{
    if ($signature === null || $timestamp === null || $eventId === null || !ctype_digit($timestamp)) {
        return null;
    }
    if (abs($now - (int) $timestamp) > $toleranceSeconds) {
        return null; // too old (or from the future): possible replay
    }
    $expected = 'v1=' . hash_hmac('sha256', $timestamp . '.' . $eventId . '.' . $rawBody, $secret);
    if (!hash_equals($expected, $signature)) {
        return null;
    }
    try {
        $event = json_decode($rawBody, true, 64, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        return null;
    }
    return is_array($event) && ($event['id'] ?? null) === $eventId ? $event : null;
}

/** At-least-once delivery: remember processed event ids (use your database in production). */
function nocustody_seen(string $eventId, string $store): bool
{
    $ids = is_file($store) ? file($store, FILE_IGNORE_NEW_LINES) : [];
    if (in_array($eventId, $ids, true)) {
        return true;
    }
    file_put_contents($store, $eventId . PHP_EOL, FILE_APPEND | LOCK_EX);
    return false;
}

if (PHP_SAPI !== 'cli') {
    $secret = (string) getenv('NOCUSTODY_WEBHOOK_SECRET');
    $raw = (string) file_get_contents('php://input');
    $event = $secret === '' ? null : nocustody_verify(
        $secret,
        $raw,
        $_SERVER['HTTP_X_SIGNATURE'] ?? null,
        $_SERVER['HTTP_X_TIMESTAMP'] ?? null,
        $_SERVER['HTTP_X_EVENT_ID'] ?? null,
        time(),
    );
    if ($event === null) {
        http_response_code(400);
        exit;
    }
    $log = getenv('NOCUSTODY_WEBHOOK_LOG') ?: sys_get_temp_dir() . '/nocustody-events.log';
    if (!nocustody_seen($event['id'], $log . '.ids')) {
        // Do the real work asynchronously (queue a job). Grant access on invoice.completed.
        file_put_contents($log, json_encode($event, JSON_UNESCAPED_SLASHES) . PHP_EOL, FILE_APPEND | LOCK_EX);
    }
    http_response_code(204);
}
