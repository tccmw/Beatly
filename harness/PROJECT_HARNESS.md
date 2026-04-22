# Beatly Project Harness

이 하네스는 Beatly의 품질 기준을 코드 변경 시마다 비교할 수 있는 프로젝트 계약이다.
최종 산출물은 "MP3 업로드 -> 드러머가 바로 읽고 연주할 수 있는 드럼 악보 + 시간 동기화 가사"여야 한다.

## Ultimate Goal

- 사용자는 MP3 파일을 업로드한다.
- 시스템은 실제 드러머가 즉시 연주할 수 있는 깨끗하고 전문적인 악보를 생성한다.
- 악보는 기성 드럼 악보 수준의 가독성, 마디 배치, 성부 분리, 리듬 정렬을 갖춘다.
- 드럼 비트와 한국어 가사는 하나의 시간축에서 결합되며, 가사는 악보 하단의 독립 Lyric Lane에 겹침 없이 배치된다.

## Mandatory Rules

- 표준 드럼 기보법을 따른다.
- PAS 기준 매핑을 고정한다.
- 베이스 드럼: 1번 칸, `f/4`, Voice 2, 아래 기둥.
- 스네어: 3번 칸, `c/5`, Voice 1, 위 기둥.
- 하이햇: 5번 선, `g/5`, `x` notehead, Voice 1, 위 기둥.
- 크래시: `a/5`, `x` notehead, Voice 1, 위 기둥.
- 라이드: `f/5`, `x` notehead, Voice 1, 위 기둥.
- 탐: `e/5`, normal notehead, Voice 1, 위 기둥.
- 손 성부와 발 성부를 분리한다.
- 손: Voice 1, stem up.
- 발: Voice 2, stem down.
- 프론트엔드 렌더에서는 악기별 표준 display lane을 고정한다.
- 크래시는 가장 높은 cymbal lane, 하이햇은 그 아래 cymbal lane, 라이드는 top-line cymbal lane을 사용한다.
- 탐은 상단 drum lane, 스네어는 중단 drum lane, 킥은 하단 drum lane을 사용한다.
- 같은 슬롯에 cymbal과 drum이 함께 있어도 같은 Y 좌표에 놓이면 안 된다.
- 같은 슬롯의 손 성부 혼합 타격은 같은 stem 축을 공유할 수 있지만, notehead는 각 악기의 display lane에 남아야 한다.
- 발 성부에는 긴 연결 보를 만들지 않는다.
- 모든 리듬은 최소 16분 음표 슬롯으로 퀀타이즈한다.
- 32분/64분 음표는 생성하지 않는다.
- 드럼 히트가 없는 시간이라도 가사가 있으면 해당 16분 슬롯에 가사를 반드시 유지한다.
- Whisper는 `large-v3` 계열 모델과 `word_timestamps=True` 방식으로 단어 시작/종료 시간을 확보하는 구성을 목표로 한다.
- Whisper 모델은 앱 시작 시 또는 캐시된 로더를 통해 재사용하고, 요청마다 새로 로드하지 않는다.

## Hard Constraints

- 사람이 연주할 수 없는 3개 이상의 동시 손 타격을 기보하지 않는다.
- 초고속 베이스 드럼 연타나 노이즈성 킥을 그대로 기보하지 않는다.
- 음표 밖으로 삐져나온 beam, 휘어진 flag, 수직 정렬이 맞지 않는 음표 더미를 방치하지 않는다.
- 한국어 가사 음절을 한 슬롯에 과도하게 뭉치게 하지 않는다.
- 후처리 과정에서 `lyric=None`으로 가사 데이터를 증발시키지 않는다.
- Demucs/Whisper 같은 무거운 모델을 매 요청마다 재로드하지 않는다.

## Technical Pipeline Contract

1. 전처리: Demucs로 `vocals.wav`와 `drums.wav`를 분리한다.
2. 드럼 분석: 분리된 드럼 트랙에서 히트 시점과 악기군을 추출한다.
3. 가사 추출: 분리된 보컬 트랙에서 Whisper `word_timestamps=True`로 단어 단위 타임스탬프를 얻는다.
4. 병합: 단어 타임스탬프와 드럼 히트를 같은 1/16 슬롯 좌표로 변환한다.
5. 기보 후처리: PAS 매핑, 성부 분리, 연주 가능성, 16분 퀀타이즈, 킥 밀도 제한을 적용한다.
6. 렌더링: `DrumSheet.tsx`는 드럼 음표와 별개로 Lyric Lane을 그린다.

## Acceptance Gates

- API 응답의 `midi_ticks`는 모두 `tick % 120 == 0`이어야 한다.
- `engraved_measures[*].voice1`과 `voice2`는 각 마디마다 4/4 박자 합계를 만족해야 한다.
- `duration`은 `q`, `8`, `16`만 허용한다.
- Voice 1에는 손 악기만, Voice 2에는 킥만 들어간다.
- 같은 tick의 손 악기는 최대 2개까지만 허용한다.
- Voice 2는 16분 연속 보를 만들 수 있는 출력으로 남기지 않는다.
- `words`에 존재하는 가사는 `engraved_measures[*].lyric_slots` 또는 `slots`에 남아 있어야 한다.
- 하이햇은 `g/5` + `x`, 스네어는 `c/5` + normal, 킥은 `f/4` + normal로 렌더링되어야 한다.
- 손 성부의 `x` notehead는 크래시/하이햇/라이드별 cymbal lane에 렌더링되어야 한다.
- 손 성부의 normal notehead는 탐/스네어별 drum lane에 렌더링되어야 한다.
- 같은 슬롯의 손 성부에서 `x`와 normal이 함께 존재할 때, 두 notehead는 서로 다른 Y 좌표로 렌더링되어야 한다.

## Executable Harness

실행 가능한 검증 스크립트는 `harness/beatly_quality_harness.py`에 있다.

```powershell
py -3 harness\beatly_quality_harness.py
# 또는 Python이 `python` 명령으로 설치된 환경:
python harness\beatly_quality_harness.py
```

이 스크립트는 현재 백엔드 표기 로직을 대상으로 다음 회귀 케이스를 검사한다.

- PAS 매핑과 성부 분리
- 16분 슬롯 퀀타이즈와 32분/64분 금지
- 드럼 히트가 없는 슬롯의 가사 보존
- 3개 이상 동시 손 타격 제거
- 과도한 킥 밀도 제한과 발 성부 16분 beam 방지
- Whisper 모델 캐시/프리로드 구조 유지
