<?php

declare(strict_types=1);

use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Models\AgentOptions;
use Firecrawl\Models\AgentStatusResponse;
use GuzzleHttp\Psr7\Response;

it('sends the effort parameter when starting an agent', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'agent-123'])),
    ], $history);

    $response = $client->startAgent(AgentOptions::with(
        prompt: 'find pricing',
        effort: 'high',
    ));

    expect($response->isSuccess())->toBeTrue();
    expect($response->getId())->toBe('agent-123');

    $request = $history[0]['request'];
    expect($request->getUri()->getPath())->toBe('/v2/agent');

    $body = json_decode((string) $request->getBody(), true);
    expect($body['prompt'])->toBe('find pricing');
    expect($body['effort'])->toBe('high');
});

it('omits the effort parameter when not set', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'agent-123'])),
    ], $history);

    $client->startAgent(AgentOptions::with(prompt: 'find pricing', model: 'spark-2'));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body)->not->toHaveKey('effort');
    expect($body['model'])->toBe('spark-2');
});

it('hydrates the effort on AgentStatusResponse', function (): void {
    $withEffort = AgentStatusResponse::fromArray([
        'success' => true,
        'status' => 'completed',
        'model' => 'spark-2',
        'effort' => 'medium',
        'expiresAt' => '2026-09-01T00:00:00Z',
    ]);

    expect($withEffort->getEffort())->toBe('medium');
    expect($withEffort->getModel())->toBe('spark-2');

    $withoutEffort = AgentStatusResponse::fromArray([
        'success' => true,
        'status' => 'completed',
    ]);

    expect($withoutEffort->getEffort())->toBeNull();
});

it('parses agent trace events and sends the liveView query param', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'id' => 'agent-123',
            'events' => [
                [
                    'type' => 'run.started',
                    'schemaVersion' => 1,
                    'eventId' => 'evt-1',
                    'runId' => 'agent-123',
                    'occurredAt' => '2026-08-26T10:00:00Z',
                    'producerSequence' => 1,
                    'agent' => ['id' => 'agent-root', 'role' => 'root', 'name' => 'root', 'parentId' => null],
                ],
                [
                    'type' => 'tool_call.started',
                    'schemaVersion' => 1,
                    'eventId' => 'evt-2',
                    'runId' => 'agent-123',
                    'occurredAt' => '2026-08-26T10:00:01Z',
                    'producerSequence' => 2,
                    'agent' => ['id' => 'agent-root', 'role' => 'root', 'name' => 'root'],
                    'toolCallId' => 'call-1',
                    'toolName' => 'scrape',
                    'parameters' => ['url' => 'https://example.com'],
                ],
                [
                    'type' => 'artifact.updated',
                    'schemaVersion' => 1,
                    'eventId' => 'evt-3',
                    'runId' => 'agent-123',
                    'occurredAt' => '2026-08-26T10:00:02Z',
                    'producerSequence' => 3,
                    'agent' => ['id' => 'agent-root', 'role' => 'root', 'name' => 'root'],
                    'artifact' => [
                        'kind' => 'table',
                        'artifactId' => 'art-1',
                        'path' => 'pricing',
                        'snapshotId' => 'snap-1',
                        'change' => 'rows_added',
                        'changedFields' => ['price'],
                        'itemCount' => 3,
                        'sourceToolCallId' => 'call-1',
                    ],
                ],
                [
                    'type' => 'error.occurred',
                    'schemaVersion' => 1,
                    'eventId' => 'evt-4',
                    'runId' => 'agent-123',
                    'occurredAt' => '2026-08-26T10:00:03Z',
                    'producerSequence' => 4,
                    'agent' => ['id' => 'agent-root', 'role' => 'root', 'name' => 'root'],
                    'error' => [
                        'code' => 'SCRAPE_FAILED',
                        'source' => 'tool',
                        'retryable' => true,
                        'message' => 'scrape timed out',
                    ],
                ],
            ],
            'creditsUsed' => 5,
            'activeBrowserSessions' => [
                [
                    'id' => 'session-1',
                    'liveViewUrl' => 'https://liveview.firecrawl.dev/session-1',
                    'viewport' => ['width' => 1280, 'height' => 720],
                ],
            ],
        ])),
    ], $history);

    $trace = $client->getAgentTrace('agent-123', liveView: true);

    $request = $history[0]['request'];
    expect($request->getMethod())->toBe('GET');
    expect($request->getUri()->getPath())->toBe('/v2/agent/agent-123/trace');
    expect($request->getUri()->getQuery())->toBe('liveView=true');

    expect($trace->isSuccess())->toBeTrue();
    expect($trace->getId())->toBe('agent-123');
    expect($trace->getCreditsUsed())->toBe(5);
    expect($trace->getEvents())->toHaveCount(4);

    $started = $trace->getEvents()[0];
    expect($started->getType())->toBe('run.started');
    expect($started->getSchemaVersion())->toBe(1);
    expect($started->getEventId())->toBe('evt-1');
    expect($started->getRunId())->toBe('agent-123');
    expect($started->getOccurredAt())->toBe('2026-08-26T10:00:00Z');
    expect($started->getProducerSequence())->toBe(1);
    expect($started->getAgent()->getId())->toBe('agent-root');
    expect($started->getAgent()->getRole())->toBe('root');
    expect($started->getAgent()->getParentId())->toBeNull();
    expect($started->getError())->toBeNull();
    expect($started->getArtifact())->toBeNull();

    $toolCall = $trace->getEvents()[1];
    expect($toolCall->getType())->toBe('tool_call.started');
    expect($toolCall->getToolCallId())->toBe('call-1');
    expect($toolCall->getToolName())->toBe('scrape');
    expect($toolCall->getParameters())->toBe(['url' => 'https://example.com']);
    expect($toolCall->getResult())->toBeNull();

    $artifact = $trace->getEvents()[2]->getArtifact();
    expect($artifact->getKind())->toBe('table');
    expect($artifact->getArtifactId())->toBe('art-1');
    expect($artifact->getPath())->toBe('pricing');
    expect($artifact->getSnapshotId())->toBe('snap-1');
    expect($artifact->getChange())->toBe('rows_added');
    expect($artifact->getChangedFields())->toBe(['price']);
    expect($artifact->getItemCount())->toBe(3);
    expect($artifact->getSourceToolCallId())->toBe('call-1');

    $error = $trace->getEvents()[3]->getError();
    expect($error->getCode())->toBe('SCRAPE_FAILED');
    expect($error->getSource())->toBe('tool');
    expect($error->isRetryable())->toBeTrue();
    expect($error->getMessage())->toBe('scrape timed out');

    $sessions = $trace->getActiveBrowserSessions();
    expect($sessions)->toHaveCount(1);
    expect($sessions[0]->getId())->toBe('session-1');
    expect($sessions[0]->getLiveViewUrl())->toBe('https://liveview.firecrawl.dev/session-1');
    expect($sessions[0]->getViewport()->getWidth())->toBe(1280);
    expect($sessions[0]->getViewport()->getHeight())->toBe(720);
});

it('omits the liveView query param by default', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'id' => 'agent-123',
            'events' => [],
            'creditsUsed' => 0,
        ])),
    ], $history);

    $trace = $client->getAgentTrace('agent-123');

    expect($history[0]['request']->getUri()->getQuery())->toBe('');
    expect($trace->getEvents())->toBe([]);
    expect($trace->getActiveBrowserSessions())->toBe([]);
});

it('surfaces agent trace errors', function (): void {
    $client = fakeFirecrawlClient([
        new Response(404, [], json_encode([
            'success' => false,
            'error' => 'Agent job not found',
        ])),
    ]);

    $client->getAgentTrace('agent-missing');
})->throws(FirecrawlException::class, 'Agent job not found');

it('parses an agent snapshot', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'id' => 'agent-123',
            'snapshotId' => 'snap-1',
            'snapshot' => '[{"price": "$10"}]',
        ])),
    ], $history);

    $snapshot = $client->getAgentSnapshot('agent-123', 'snap-1');

    $request = $history[0]['request'];
    expect($request->getMethod())->toBe('GET');
    expect($request->getUri()->getPath())->toBe('/v2/agent/agent-123/snapshots/snap-1');

    expect($snapshot->isSuccess())->toBeTrue();
    expect($snapshot->getId())->toBe('agent-123');
    expect($snapshot->getSnapshotId())->toBe('snap-1');
    expect($snapshot->getSnapshot())->toBe('[{"price": "$10"}]');
    expect($snapshot->getError())->toBeNull();
});

it('surfaces agent snapshot errors', function (): void {
    $client = fakeFirecrawlClient([
        new Response(404, [], json_encode([
            'success' => false,
            'error' => 'Agent job not found',
        ])),
    ]);

    $client->getAgentSnapshot('agent-missing', 'snap-1');
})->throws(FirecrawlException::class, 'Agent job not found');
