module html-to-markdown.go

go 1.23.0

toolchain go1.24.0

require (
	github.com/PuerkitoBio/goquery v1.10.3
	github.com/firecrawl/html-to-markdown v0.0.0-20260103214238-c035ce0e6258
	golang.org/x/net v0.41.0
)

require (
	github.com/andybalholm/cascadia v1.3.3 // indirect
	github.com/kr/pretty v0.3.0 // indirect
	gopkg.in/check.v1 v1.0.0-20201130134442-10cb98267c6c // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
)

replace github.com/JohannesKaufmann/html-to-markdown => github.com/firecrawl/html-to-markdown v0.0.0-20260103214238-c035ce0e6258
