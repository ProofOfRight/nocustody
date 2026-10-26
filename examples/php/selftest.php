<?php
// SPDX-License-Identifier: Apache-2.0
// php selftest.php — checks nocustody_verify() against a vector signed by the gateway (test-vector.json).
declare(strict_types=1);
require __DIR__ . '/webhook.php';

$v = json_decode((string) file_get_contents(__DIR__ . '/test-vector.json'), true, 8, JSON_THROW_ON_ERROR);
$ts = (int) $v['timestamp'];
$checks = [
    'valid signature' => nocustody_verify($v['secret'], $v['body'], $v['signature'], $v['timestamp'], $v['eventId'], $ts) !== null,
    'tampered body' => nocustody_verify($v['secret'], $v['body'] . ' ', $v['signature'], $v['timestamp'], $v['eventId'], $ts) === null,
    'wrong secret' => nocustody_verify('x' . $v['secret'], $v['body'], $v['signature'], $v['timestamp'], $v['eventId'], $ts) === null,
    'old timestamp' => nocustody_verify($v['secret'], $v['body'], $v['signature'], $v['timestamp'], $v['eventId'], $ts + 301) === null,
    'other event id' => nocustody_verify($v['secret'], $v['body'], $v['signature'], $v['timestamp'], 'other', $ts) === null,
    'missing header' => nocustody_verify($v['secret'], $v['body'], null, $v['timestamp'], $v['eventId'], $ts) === null,
];
$failed = array_keys(array_filter($checks, fn ($ok) => !$ok));
foreach ($checks as $name => $ok) {
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . PHP_EOL;
}
exit($failed === [] ? 0 : 1);
