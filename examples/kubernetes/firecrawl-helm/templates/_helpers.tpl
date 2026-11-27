{{/*
Return the name of the chart.
*/}}
{{- define "firecrawl.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Return the fully qualified name of the chart.
*/}}
{{- define "firecrawl.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
firecrawl.nodeHeapSize: V8 old-space cap (MB) for a node component.
Arguments (tuple): <.Values> <component> <defaultMB>
Falls back to <defaultMB> when .Values.nodeHeapSize is unset or the
component key is missing, so a no-values install keeps the original
per-process heap sizes.
*/}}
{{- define "firecrawl.nodeHeapSize" -}}
{{- $values := index . 0 -}}
{{- $key := index . 1 -}}
{{- $default := index . 2 -}}
{{- index (index $values "nodeHeapSize" | default (dict)) $key | default $default -}}
{{- end }}
