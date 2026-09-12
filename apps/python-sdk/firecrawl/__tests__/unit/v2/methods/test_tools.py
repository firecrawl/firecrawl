from unittest.mock import Mock
import httpx
import pytest
from firecrawl import Firecrawl, AsyncFirecrawl

TOOL = dict(id='particle/podcasts/episodes/search', provider='particle', capability='podcasts/episodes/search',
            name='Episode search', description='Find episodes', creditsCost=15, perRecord=False,
            options=[dict(name='semantic_search', type='string')], response={'fields': []}, examples={'python':'example'},
            matchedBy=['semantic', 'domain'], matchedUrls=['https://podcasts.apple.com'])
NEXT = dict(provider='firecrawl', capability='find-tools', options={'providers':['particle'], 'level':'tools'})
DATA = {'alexandria':[dict(provider=NEXT['provider'], capability=NEXT['capability'], creditsCost=0,
                         data={'level':'providers','items':[{'id':'particle','next':NEXT}], 'total':1,'next':None})], 'creditsCost':0}

def response(status, data):
    result=Mock(status_code=status)
    result.json.return_value=data
    return result

@pytest.mark.parametrize('async_client',[False,True])
@pytest.mark.asyncio
async def test_search_and_progressive_lookup(async_client, monkeypatch):
    calls=[]
    def payload(body):
        calls.append(body)
        return {'success':True, 'data': {'tools':[TOOL], 'web':[]} if 'query' in body else DATA}
    client = AsyncFirecrawl(api_key='fc-test') if async_client else Firecrawl(api_key='fc-test')
    if async_client:
        async def post(url, **kwargs): return httpx.Response(200,json=payload(kwargs['json']))
        monkeypatch.setattr(client._v2_client.async_http_client._client,'post',post)
        search=await client.search('podcasts',sources=['alexandria'],domain_tools=True)
        found=await client.find_tools(providers=['particle'],limit=2)
        result=await client.scrape(alexandria=found.items[0]['next'],request_id='walk-1')
        with pytest.raises(ValueError, match='URL cannot be empty'):
            await client.scrape()
        await client._v2_client.async_http_client.close()
    else:
        monkeypatch.setattr('requests.post',lambda url,**kwargs:response(200,payload(kwargs['json'])))
        search=client.search('podcasts',sources=['alexandria'],domain_tools=True)
        found=client.find_tools(providers=['particle'],limit=2)
        result=client.scrape(alexandria=found.items[0]['next'],request_id='walk-1')
        with pytest.raises(ValueError, match='URL cannot be empty'):
            client.scrape()
    assert search.tools[0].matched_by==['semantic','domain']
    assert search.tools[0].options==TOOL['options']
    assert calls[0]['domainTools'] is True
    assert calls[-1]['alexandria']==[NEXT]
    assert 'request_id' not in calls[-1]
    assert result.request_id=='walk-1'
    assert result.credits_cost==0


def test_retry_id_and_errors(monkeypatch):
    sent=[]
    replies=iter([response(502,{}),response(200,{'success':True,'data':DATA}),response(402,{'success':False,'error':'Insufficient credits'})])
    def post(url,**kwargs): sent.append(kwargs); return next(replies)
    monkeypatch.setattr('requests.post',post)
    client=Firecrawl(api_key='fc-test',max_retries=2,backoff_factor=0)
    client.scrape(alexandria=NEXT,request_id='retry-1')
    assert [item['headers']['x-request-id'] for item in sent]==['retry-1','retry-1']
    assert all(item['headers']['Authorization']=='Bearer fc-test' for item in sent)
    with pytest.raises(Exception) as caught: client.scrape(alexandria=NEXT,request_id='denied-1')
    assert caught.value.request_id=='denied-1'
    assert caught.value.status_code==402
    with pytest.raises(ValueError): client.scrape('https://example.com',alexandria=NEXT)
    with pytest.raises(ValueError): client.scrape(alexandria=NEXT,formats=['markdown'])
    assert len(sent)==3


@pytest.mark.parametrize('async_client', [False, True])
@pytest.mark.asyncio
async def test_execution_failure_preserves_cause_and_retry_identity(async_client, monkeypatch):
    from firecrawl.v2.utils.error_handler import FirecrawlError

    cause = ValueError('Malformed response')
    client = AsyncFirecrawl(api_key='fc-test') if async_client else Firecrawl(api_key='fc-test')
    if async_client:
        async def post(*args, **kwargs):
            raise cause
        monkeypatch.setattr(client._v2_client.async_http_client, 'post', post)
        with pytest.raises(FirecrawlError) as caught:
            await client.scrape(alexandria=NEXT, request_id='uncertain-1')
        await client._v2_client.async_http_client.close()
    else:
        def post(*args, **kwargs):
            raise cause
        monkeypatch.setattr('requests.post', post)
        with pytest.raises(FirecrawlError) as caught:
            client.scrape(alexandria=NEXT, request_id='uncertain-1')
    assert caught.value.request_id == 'uncertain-1'
    assert caught.value.__cause__ is cause
