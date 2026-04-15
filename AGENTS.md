# Beatly Agent Instructions

이 파일은 Beatly에서 작업하는 AI 에이전트가 매 작업 전에 따라야 하는 핵심 규약이다.
악보, 가사, 오디오 분석, 렌더링, API 응답 구조를 변경하기 전에는 반드시 `harness/PROJECT_HARNESS.md`도 확인한다.

## Ultimate Goal

MP3 업로드만으로 실제 드러머가 바로 읽고 연주할 수 있는 전문 드럼 악보를 생성한다.
드럼 비트와 한국어 가사는 같은 시간축 위에서 동기화되어야 하며, 가사는 악보 하단의 독립 Lyric Lane에 겹침 없이 표시되어야 한다.

## Mandatory Rules

- PAS 기준 드럼 위치를 고정한다.
- Kick: `f/4`, MIDI 36, Voice 2, normal notehead.
- Snare: `c/5`, MIDI 38, Voice 1, normal notehead.
- Hi-hat closed/open: `g/5`, MIDI 42/46, Voice 1, `x` notehead.
- 손 성부는 Voice 1, stem up으로 유지한다.
- 발 성부는 Voice 2, stem down으로 유지한다.
- 발 성부에는 긴 연결 beam이나 조밀한 16분 beam이 생기지 않게 한다.
- 모든 드럼 이벤트는 최소 16분 음표 슬롯으로 퀀타이즈한다.
- 32분/64분 음표나 그에 준하는 세밀한 리듬 표기는 만들지 않는다.
- 드럼 히트가 없는 슬롯이라도 해당 시간에 가사가 있으면 Lyric Lane에 반드시 남긴다.
- 가사는 드럼 이벤트의 `lyric` 필드에 의존하지 말고 독립 가사 슬롯으로 보존한다.
- Whisper는 `word_timestamps=True`를 사용해야 한다.
- Whisper 모델은 캐시/프리로드로 재사용하고 요청마다 재로드하지 않는다.

## Hard Constraints

- 3개 이상의 동시 손 타격을 기보하지 않는다.
- 노이즈성 초고속 킥 연타를 그대로 기보하지 않는다.
- Voice 1에는 손 악기만, Voice 2에는 kick만 들어가야 한다.
- 한국어 가사 음절을 한 슬롯에 과도하게 뭉치게 하지 않는다.
- 후처리 중 `lyric=None`으로 기존 가사 데이터를 증발시키지 않는다.
- 음표 밖으로 삐져나온 beam, 휘어진 flag, 수직 정렬 오류를 방치하지 않는다.
- 기존 사용자 변경을 되돌리지 않는다.

## Pipeline Contract

1. Demucs로 vocals/drums stem을 분리한다.
2. drums stem에서 드럼 히트를 분석한다.
3. vocals stem에서 Whisper 단어 타임스탬프를 추출한다.
4. 드럼 히트와 가사를 1/16 슬롯 좌표로 병합한다.
5. 백엔드 표기 후처리에서 PAS 매핑, 성부 분리, 연주 가능성, 킥 밀도 제한을 적용한다.
6. 프론트엔드 `DrumSheet.tsx`는 드럼 음표와 별개로 Lyric Lane을 렌더링한다.

## Required Checks

악보, 가사 정렬, 드럼 분석, Whisper, 또는 `DrumSheet.tsx`를 변경했다면 가능한 경우 다음 하네스를 실행한다.

```powershell
py -3 harness\beatly_quality_harness.py
```

Python이 `python` 명령으로 설치된 환경에서는 다음을 사용한다.

```powershell
python harness\beatly_quality_harness.py
```

실행할 수 없는 환경이면 최종 보고에 그 이유를 명시한다.
