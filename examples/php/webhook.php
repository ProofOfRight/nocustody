<?php
// SPDX-License-Identifier: Apache-2.0
// Webhook receiver for nocustody. Plain PHP 8.1+, no Composer packages.
//   php -S 0.0.0.0:8000 webhook.php        (for local testing; use your normal web server in production)
// Environment: NOCUSTODY_WEBHOOK_SECRET; NOCUSTODY_WEBHOOK_LOG — file to append accepted events to, in a directory
// only this application can write, outside the web root and not in a shared /tmp (anyone who can create
// "<log>.ids" there could make the receiver drop events as already processed).
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

/**
 * At-least-once delivery: runs $handle once per event id. The check, the work and the record of the id happen under
 * an exclusive lock, so two concurrent deliveries of one event cannot both run it, and an id is recorded only after
 * $handle returned: if it throws, the id stays unrecorded and the gateway's retry runs it again. The file store is
 * for the example; in production keep processed ids in your database, check and insert in one transaction.
 * Returns false when the event had been processed before.
 */
function nocustody_once(string $eventId, string $store, callable $handle): bool
{
    $h = fopen($store, 'c+');
    if ($h === false) {
        throw new RuntimeException("cannot open $store");
    }
    try {
        if (!flock($h, LOCK_EX)) {
            throw new RuntimeException("cannot lock $store");
        }
        while (($line = fgets($h)) !== false) {
            if (rtrim($line, "\r\n") === $eventId) {
                return false;
            }
        }
        $handle();
        fseek($h, 0, SEEK_END);
        if (fwrite($h, $eventId . PHP_EOL) === false || !fflush($h)) {
            throw new RuntimeException("cannot record $eventId in $store");
        }
        return true;
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
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
    $log = (string) getenv('NOCUSTODY_WEBHOOK_LOG');
    if ($log === '') {
        error_log('nocustody webhook: NOCUSTODY_WEBHOOK_LOG is not set');
        http_response_code(500); // the gateway retries; nothing is lost while the receiver is misconfigured
        exit;
    }
    try {
        nocustody_once($event['id'], $log . '.ids', function () use ($log, $event): void {
            // Do the real work asynchronously (queue a job). Grant access on invoice.completed.
            $line = json_encode($event, JSON_UNESCAPED_SLASHES) . PHP_EOL;
            if (file_put_contents($log, $line, FILE_APPEND | LOCK_EX) === false) {
                throw new RuntimeException("cannot append to $log");
            }
        });
    } catch (RuntimeException $e) {
        error_log('nocustody webhook: ' . $e->getMessage());
        http_response_code(500);
        exit;
    }
    http_response_code(204);
}
