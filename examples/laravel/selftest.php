<?php
// SPDX-License-Identifier: Apache-2.0
// php selftest.php — checks WebhookSignature::verify() against the vector signed by the gateway (../php/test-vector.json).
declare(strict_types=1);
require __DIR__ . '/app/Services/Nocustody/WebhookSignature.php';

use App\Services\Nocustody\WebhookSignature;

$v = json_decode((string) file_get_contents(__DIR__ . '/../php/test-vector.json'), true, 8, JSON_THROW_ON_ERROR);
$ts = (int) $v['timestamp'];
$verify = fn (string $secret, string $body, ?string $sig, string $id, int $now) =>
    WebhookSignature::verify($secret, $body, $sig, $v['timestamp'], $id, $now);
$checks = [
    'valid signature' => $verify($v['secret'], $v['body'], $v['signature'], $v['eventId'], $ts) !== null,
    'tampered body' => $verify($v['secret'], $v['body'] . ' ', $v['signature'], $v['eventId'], $ts) === null,
    'wrong secret' => $verify('x' . $v['secret'], $v['body'], $v['signature'], $v['eventId'], $ts) === null,
    'empty secret' => $verify('', $v['body'], $v['signature'], $v['eventId'], $ts) === null,
    'old timestamp' => $verify($v['secret'], $v['body'], $v['signature'], $v['eventId'], $ts + 301) === null,
    'other event id' => $verify($v['secret'], $v['body'], $v['signature'], 'other', $ts) === null,
    'missing header' => $verify($v['secret'], $v['body'], null, $v['eventId'], $ts) === null,
];
foreach ($checks as $name => $ok) {
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . PHP_EOL;
}
exit(in_array(false, $checks, true) ? 1 : 0);
