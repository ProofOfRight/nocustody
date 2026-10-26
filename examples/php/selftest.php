<?php
// SPDX-License-Identifier: Apache-2.0
// php selftest.php — checks nocustody_verify() against a vector signed by the gateway (test-vector.json) and the
// once-per-event handling of nocustody_once().
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
$store = tempnam(sys_get_temp_dir(), 'nc-ids-');
$runs = 0;
$count = function () use (&$runs): void {
    $runs++;
};
$failing = function (): void {
    throw new RuntimeException('handler failed');
};
$threw = false;
try {
    nocustody_once('evt-2', $store, $failing);
} catch (RuntimeException) {
    $threw = true;
}
$checks += [
    'first delivery runs the handler' => nocustody_once('evt-1', $store, $count) === true && $runs === 1,
    'a repeated delivery does not' => nocustody_once('evt-1', $store, $count) === false && $runs === 1,
    'a failed handler leaves the id unrecorded' => $threw && nocustody_once('evt-2', $store, $count) === true && $runs === 2,
];
unlink($store);
$failed = array_keys(array_filter($checks, fn ($ok) => !$ok));
foreach ($checks as $name => $ok) {
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . PHP_EOL;
}
exit($failed === [] ? 0 : 1);
