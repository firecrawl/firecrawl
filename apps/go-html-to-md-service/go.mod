module github.com/firecrawl/go-html-to-md-service

go 1.23.0

require (
	github.com/PuerkitoBio/goquery v1.10.3
	github.com/firecrawl/html-to-markdown v0.0.0-20260103214238-c035ce0e6258
	github.com/gorilla/mux v1.8.1
	github.com/rs/zerolog v1.33.0
	golang.org/x/net v0.41.0
)

require (
	github.com/andybalholm/cascadia v1.3.3 // indirect
	github.com/kr/pretty v0.3.0 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	golang.org/x/sys v0.33.0 // indirect
	gopkg.in/check.v1 v1.0.0-20201130134442-10cb98267c6c // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
)

replace github.com/JohannesKaufmann/html-to-markdown => github.com/firecrawl/html-to-markdown v0.0.0-20260103214238-c035ce0e6258
