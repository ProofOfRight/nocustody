<?php
// SPDX-License-Identifier: Apache-2.0
// config/nocustody.php — values come from .env; nothing secret is committed.

return [
    // Merchant API of the gateway, reachable only from the backend (private network or VPN, behind TLS).
    'api_url' => env('NOCUSTODY_API_URL', 'https://pay.internal.example'),
    'api_key' => env('NOCUSTODY_API_KEY'),

    // Public origin of the hosted payment page (/pay/{id}); null if the shop renders its own page.
    'public_url' => env('NOCUSTODY_PUBLIC_URL'),

    // Webhook secret: separate from the API key, at least 32 characters.
    'webhook_secret' => env('NOCUSTODY_WEBHOOK_SECRET'),
    'webhook_tolerance' => 300,

    'timeout' => 10,
];
