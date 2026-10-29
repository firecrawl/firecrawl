<?php

declare(strict_types=1);

use Firecrawl\Models\AgentExchangeApproval;
use Firecrawl\Models\AgentExchangeDecline;
use Firecrawl\Models\AgentExchangeOptions;
use Firecrawl\Models\AgentOptions;
use GuzzleHttp\Psr7\Response;

it('sends exchange, threadId and mode with their wire names', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'id' => 'run-2',
            'threadId' => '7b0c2f4e-1d7a-4c4e-9a4f-2f6d8a1b3c5d',
            'threadTurn' => 2,
        ])),
    ], $history);

    $response = $client->startAgent(AgentOptions::with(
        prompt: 'go ahead',
        threadId: '7b0c2f4e-1d7a-4c4e-9a4f-2f6d8a1b3c5d',
        mode: 'chat',
        exchange: AgentExchangeOptions::with(
            enabled: true,
            toolkits: ['acme-data', 'globex'],
            maxCalls: 4,
            requireApproval: true,
            approve: AgentExchangeApproval::with(
                approvalId: '0f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918',
                callIds: ['call-1'],
                always: false,
            ),
            onTermsRequired: 'ask',
        ),
    ));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['threadId'])->toBe('7b0c2f4e-1d7a-4c4e-9a4f-2f6d8a1b3c5d');
    expect($body['mode'])->toBe('chat');
    expect($body['exchange'])->toBe([
        'enabled' => true,
        'toolkits' => ['acme-data', 'globex'],
        'maxCalls' => 4,
        'requireApproval' => true,
        'approve' => [
            'approvalId' => '0f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918',
            'callIds' => ['call-1'],
            'always' => false,
        ],
        'onTermsRequired' => 'ask',
    ]);

    expect($response->getId())->toBe('run-2');
    expect($response->getThreadId())->toBe('7b0c2f4e-1d7a-4c4e-9a4f-2f6d8a1b3c5d');
    expect($response->getThreadTurn())->toBe(2);
});

it('sends a decline through the polling agent helper', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'run-3'])),
        new Response(200, [], json_encode(['success' => true, 'status' => 'completed'])),
    ], $history);

    $client->agent(AgentOptions::with(
        prompt: 'skip it',
        threadId: '7b0c2f4e-1d7a-4c4e-9a4f-2f6d8a1b3c5d',
        mode: 'chat',
        exchange: AgentExchangeOptions::with(
            decline: AgentExchangeDecline::with('0f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918'),
        ),
    ));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['exchange'])->toBe([
        'decline' => ['approvalId' => '0f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918'],
    ]);
});

it('omits unset thread and exchange options', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'run-1'])),
        new Response(200, [], json_encode(['success' => true, 'id' => 'run-2'])),
        new Response(200, [], json_encode(['success' => true, 'id' => 'run-3'])),
    ], $history);

    $response = $client->startAgent(AgentOptions::with(prompt: 'find pricing'));
    $client->startAgent(AgentOptions::with(
        prompt: 'find pricing',
        exchange: AgentExchangeOptions::with(enabled: true, toolkits: ['acme-data']),
    ));
    $client->startAgent(AgentOptions::with(
        prompt: 'find pricing',
        exchange: AgentExchangeOptions::with(),
    ));

    $plain = json_decode((string) $history[0]['request']->getBody(), true);
    expect($plain)->not->toHaveKeys(['threadId', 'mode', 'exchange']);
    expect($response->getThreadId())->toBeNull();
    expect($response->getThreadTurn())->toBeNull();

    $partial = json_decode((string) $history[1]['request']->getBody(), true);
    expect($partial['exchange'])->toBe(['enabled' => true, 'toolkits' => ['acme-data']]);

    expect((string) $history[2]['request']->getBody())->toContain('"exchange":{}');
});

it('hydrates the exchange summary and a pending calls approval on the status response', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'status' => 'completed',
            'threadId' => '7b0c2f4e-1d7a-4c4e-9a4f-2f6d8a1b3c5d',
            'threadTurn' => 1,
            'mode' => 'chat',
            'message' => 'Two paid lookups need your approval.',
            'suggestions' => [['label' => 'Approve', 'prompt' => 'go ahead']],
            'notYetKnownField' => ['ignored' => true],
            'pendingApproval' => [
                'id' => '0f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918',
                'kind' => 'calls',
                'reason' => 'Paid provider calls need approval.',
                'calls' => [[
                    'id' => 'call-1',
                    'provider' => 'acme-data',
                    'capability' => 'company/lookup',
                    'input' => ['domain' => 'example.com'],
                    'more' => [['domain' => 'example.org']],
                    'creditsEstimate' => 20,
                ]],
                'resolution' => null,
            ],
            'exchange' => [
                'enabled' => true,
                'toolkits' => ['acme-data'],
                'requireApproval' => true,
                'onTermsRequired' => 'ask',
                'paidCalls' => 0,
                'creditsUsed' => null,
                'skippedProviders' => [[
                    'provider' => 'globex',
                    'name' => 'Globex',
                    'capability' => 'people/search',
                    'adds' => 'Contact details',
                    'reason' => 'terms_required',
                    'version' => '2026-09-01',
                    'termsUrl' => 'https://example.com/terms/globex',
                ]],
                'requiresAction' => [
                    'type' => 'accept_terms',
                    'approvalId' => '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
                    'providers' => [[
                        'provider' => 'globex',
                        'name' => 'Globex',
                        'version' => '2026-09-01',
                        'digest' => null,
                        'url' => 'https://example.com/terms/globex',
                        'show' => [
                            'provider' => 'firecrawl',
                            'capability' => 'terms/show',
                            'options' => ['provider' => 'globex'],
                        ],
                        'accept' => [
                            'provider' => 'firecrawl',
                            'capability' => 'terms/accept',
                            'options' => [
                                'provider' => 'globex',
                                'version' => '2026-09-01',
                                'digest' => null,
                                'confirmed' => true,
                            ],
                        ],
                    ]],
                ],
            ],
        ])),
    ]);

    $status = $client->getAgentStatus('run-1');

    expect($status->getThreadId())->toBe('7b0c2f4e-1d7a-4c4e-9a4f-2f6d8a1b3c5d');
    expect($status->getThreadTurn())->toBe(1);
    expect($status->getMode())->toBe('chat');
    expect($status->getMessage())->toBe('Two paid lookups need your approval.');

    $approval = $status->getPendingApproval();
    expect($approval->getId())->toBe('0f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918');
    expect($approval->getKind())->toBe('calls');
    expect($approval->getReason())->toBe('Paid provider calls need approval.');
    expect($approval->getTerms())->toBe([]);
    expect($approval->getResolution())->toBeNull();
    expect($approval->getCalls())->toHaveCount(1);

    $call = $approval->getCalls()[0];
    expect($call->getId())->toBe('call-1');
    expect($call->getProvider())->toBe('acme-data');
    expect($call->getCapability())->toBe('company/lookup');
    expect($call->getInput())->toBe(['domain' => 'example.com']);
    expect($call->getMore())->toBe([['domain' => 'example.org']]);
    expect($call->getCreditsEstimate())->toBe(20);

    $exchange = $status->getExchange();
    expect($exchange->isEnabled())->toBeTrue();
    expect($exchange->getToolkits())->toBe(['acme-data']);
    expect($exchange->getRequireApproval())->toBeTrue();
    expect($exchange->getOnTermsRequired())->toBe('ask');
    expect($exchange->getPaidCalls())->toBe(0);
    expect($exchange->getCreditsUsed())->toBeNull();

    $skipped = $exchange->getSkippedProviders();
    expect($skipped)->toHaveCount(1);
    expect($skipped[0]->getProvider())->toBe('globex');
    expect($skipped[0]->getName())->toBe('Globex');
    expect($skipped[0]->getCapability())->toBe('people/search');
    expect($skipped[0]->getAdds())->toBe('Contact details');
    expect($skipped[0]->getReason())->toBe('terms_required');
    expect($skipped[0]->getVersion())->toBe('2026-09-01');
    expect($skipped[0]->getTermsUrl())->toBe('https://example.com/terms/globex');

    $action = $exchange->getRequiresAction();
    expect($action->getType())->toBe('accept_terms');
    expect($action->getApprovalId())->toBe('5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a');
    expect($action->getProviders())->toHaveCount(1);

    $provider = $action->getProviders()[0];
    expect($provider->getProvider())->toBe('globex');
    expect($provider->getVersion())->toBe('2026-09-01');
    expect($provider->getDigest())->toBeNull();
    expect($provider->getUrl())->toBe('https://example.com/terms/globex');
    expect($provider->getShow()['capability'])->toBe('terms/show');
    expect($provider->getAccept()['options'])->toBe([
        'provider' => 'globex',
        'version' => '2026-09-01',
        'digest' => null,
        'confirmed' => true,
    ]);
});

it('reads a pending approval without a kind as a calls approval', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'status' => 'completed',
            'pendingApproval' => [
                'id' => '0f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918',
                'reason' => 'Paid provider calls need approval.',
                'calls' => [],
                'resolution' => [
                    'approved' => true,
                    'callIds' => ['call-1'],
                    'always' => false,
                    'byRunId' => 'run-2',
                ],
            ],
        ])),
    ]);

    $approval = $client->getAgentStatus('run-1')->getPendingApproval();

    expect($approval->getKind())->toBe('calls');
    expect($approval->getResolution()->isApproved())->toBeTrue();
    expect($approval->getResolution()->getCallIds())->toBe(['call-1']);
    expect($approval->getResolution()->isAlways())->toBeFalse();
    expect($approval->getResolution()->getByRunId())->toBe('run-2');
});

it('leaves thread and exchange fields null on a plain status response', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'status' => 'processing'])),
    ]);

    $status = $client->getAgentStatus('run-1');

    expect($status->getThreadId())->toBeNull();
    expect($status->getMode())->toBeNull();
    expect($status->getMessage())->toBeNull();
    expect($status->getPendingApproval())->toBeNull();
    expect($status->getExchange())->toBeNull();
});
