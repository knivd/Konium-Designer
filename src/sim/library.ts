/**
 * Konium's built-in simulation models: model files (.mdl, one .MODEL; .ckt, one .SUBCKT) by
 * their file name, found when a part's SIM model names a file that neither the project nor its
 * libraries hold. The device models are the manufacturers' published model cards as commonly
 * circulated; level-1 MOSFETs set for their on-resistance [est]; the op-amp is Konium's own
 * generic macro-model [est].
 */

export const BUILTIN_MODELS: Record<string, string> = {
  '1N4148.mdl': '.MODEL 1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)',
  '1N914.mdl': '.MODEL 1N914 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)',
  '1N4001.mdl': '.MODEL 1N4001 D(IS=14.11n RS=33.89m N=1.984 CJO=25.89p VJ=0.3245 M=0.44 TT=5.7u BV=50 IBV=10u)',
  '1N4007.mdl': '.MODEL 1N4007 D(IS=14.11n RS=33.89m N=1.984 CJO=25.89p VJ=0.3245 M=0.44 TT=5.7u BV=1000 IBV=10u)',
  '1N5819.mdl': '.MODEL 1N5819 D(IS=31.7u RS=51m N=1.373 CJO=190p M=0.3 EG=0.69 XTI=2 BV=40 IBV=1m)',
  '1N4733A.mdl': '.MODEL 1N4733A D(IS=1.2f RS=7 N=1 CJO=185p M=0.33 BV=5.1 IBV=49m)',
  'LED_RED.mdl': '.MODEL LED_RED D(IS=93.2p RS=42m N=3.73 CJO=2.97p VJ=0.75 M=0.333 TT=4.32u BV=5 IBV=10u)',
  'LED_GREEN.mdl': '.MODEL LED_GREEN D(IS=1e-20 RS=2 N=2 CJO=10p M=0.333 BV=5 IBV=10u)',
  '2N3904.mdl': '.MODEL 2N3904 NPN(IS=6.734f XTI=3 EG=1.11 VAF=74.03 BF=416.4 NE=1.259 ISE=6.734f IKF=66.78m XTB=1.5 BR=0.7371 NC=2 ISC=0 IKR=0 RC=1 CJC=3.638p MJC=0.3085 VJC=0.75 FC=0.5 CJE=4.493p MJE=0.2593 VJE=0.75 TR=239.5n TF=301.2p ITF=0.4 VTF=4 XTF=2 RB=10)',
  '2N3906.mdl': '.MODEL 2N3906 PNP(IS=1.41f XTI=3 EG=1.11 VAF=18.7 BF=180.7 NE=1.5 ISE=0 IKF=80m XTB=1.5 BR=4.977 NC=2 ISC=0 IKR=0 RC=2.5 CJC=9.728p MJC=0.5776 VJC=0.75 FC=0.5 CJE=8.063p MJE=0.3677 VJE=0.75 TR=33.42n TF=179.3p ITF=0.4 VTF=4 XTF=6 RB=10)',
  'BC547B.mdl': '.MODEL BC547B NPN(IS=2.39E-14 NF=1.008 ISE=3.545E-15 NE=1.541 BF=294.3 IKF=0.1357 VAF=63.2 NR=1.004 ISC=6.272E-14 NC=1.243 BR=7.946 IKR=0.1144 VAR=25.9 RB=1 RE=0.4683 RC=0.85 CJE=1.358E-11 VJE=0.65 MJE=0.3279 TF=4.391E-10 XTF=120 VTF=2.643 ITF=0.7495 CJC=3.728E-12 VJC=0.3997 MJC=0.2955 TR=1E-32 FC=0.9579)',
  '2N7002.mdl': '.MODEL 2N7002 NMOS(LEVEL=1 VTO=2.1 KP=120m LAMBDA=10m CBD=20p CBS=20p CGSO=10n CGDO=2n)',
  'BSS84.mdl': '.MODEL BSS84 PMOS(LEVEL=1 VTO=-1.6 KP=50m LAMBDA=10m CBD=15p CBS=15p CGSO=8n CGDO=2n)',
  '2N2222A.mdl': '.MODEL 2N2222A NPN(IS=14.34f XTI=3 EG=1.11 VAF=74.03 BF=255.9 NE=1.307 ISE=14.34f IKF=0.2847 XTB=1.5 BR=6.092 NC=2 ISC=0 IKR=0 RC=1 CJC=7.306p MJC=0.3416 VJC=0.75 FC=0.5 CJE=22.01p MJE=0.377 VJE=0.75 TR=46.91n TF=411.1p ITF=0.6 VTF=1.7 XTF=3 RB=10)',
  'BC557B.mdl': '.MODEL BC557B PNP(IS=3.83E-14 NF=1.008 ISE=1.22E-14 NE=1.528 BF=344.4 IKF=0.08039 VAF=21.11 NR=1.005 ISC=2.85E-13 NC=1.28 BR=14.84 IKR=0.047 VAR=32.02 RB=1 RE=0.6202 RC=0.5713 CJE=1.23E-11 VJE=0.6106 MJE=0.378 TF=5.6E-10 XTF=3.414 VTF=5.23 ITF=0.1483 CJC=1.08E-11 VJC=0.1022 MJC=0.3563 TR=1E-32 FC=0.8027)',
  'BAT54.mdl': '.MODEL BAT54 D(IS=200n RS=2.3 N=1.04 CJO=10p VJ=0.3 M=0.33 BV=30 IBV=1u)',
  'IRF540.mdl': '.MODEL IRF540 NMOS(LEVEL=1 VTO=3.5 KP=3.5 LAMBDA=5m CBD=1n CBS=1n CGSO=1u CGDO=200n)',
  '2N5457.mdl': '.MODEL 2N5457 NJF(BETA=1.125m LAMBDA=2.3m VTO=-1.372 IS=181.3f RD=1 RS=1 CGD=2p CGS=2.2p M=0.3622 PB=1 FC=0.5)',
  'OPAMP.ckt': `.SUBCKT OPAMP 1 2 3 4 5
* Generic operational amplifier [est]: pins IN+ IN- V+ V- OUT
* 10MEG input resistance, 200k open-loop gain, dominant pole at 5 Hz (1 MHz gain-bandwidth),
* output 75 ohms, swinging to within 1.2 V of either supply; 1 mA quiescent from a 30 V supply
RIN 1 2 10MEG
G1 0 10 1 2 1m
R1 10 0 200MEG
C1 10 0 159p
B1 12 0 V={limit(V(10) + (V(3) + V(4)) / 2, V(4) + 1.2, V(3) - 1.2)}
ROUT 12 5 75
RQ 3 4 30k
.ENDS OPAMP`,
  // Parts set by a few plain values of their own (Live Simulation's palette): each a subcircuit that takes them as parameters [est]
  'OPAMP_IDEAL.ckt': `.SUBCKT OPAMP_IDEAL 1 2 3 PARAMS: GAIN=100k VMAX=15 VMIN=-15 GBW=1MEG
* An operational amplifier for a sketch: pins IN+ IN- OUT, no supply pins, no input current.
* Open-loop gain GAIN with one pole (gain-bandwidth GBW), output 1 ohm, held between VMIN and VMAX
G1 0 10 1 2 1m
R1 10 0 {GAIN*1k}
C1 10 0 {1/(6.283185*1k*GBW)}
B1 12 0 V={limit(V(10), VMIN, VMAX)}
ROUT 12 3 1
.ENDS OPAMP_IDEAL`,
  'COMPARATOR.ckt': `.SUBCKT COMPARATOR 1 2 3 PARAMS: VHIGH=5 VLOW=0
* A comparator: pins IN+ IN- OUT. The output is VHIGH with + above -, VLOW below, the change within a millivolt or so
B1 10 0 V={(VHIGH+VLOW)/2+(VHIGH-VLOW)/2*tanh(2000*(V(1)-V(2)))}
ROUT 10 3 10
COUT 3 0 10p
.ENDS COMPARATOR`,
  'DIODE_VF.ckt': `.SUBCKT DIODE_VF 1 2 PARAMS: VF=0.7 IF=10m RS=0.5 BV=100 N=1.8
* A diode set by its forward voltage: VF across it (its series resistance RS included) at the current IF
D1 1 2 DM
.MODEL DM D(IS={IF/(exp((VF-IF*RS)/(N*0.025865))-1)} N={N} RS={RS} BV={BV} IBV=1m CJO=2p TT=5n)
.ENDS DIODE_VF`,
  'NPN_BETA.ckt': `.SUBCKT NPN_BETA 1 2 3 PARAMS: BF=100 VAF=100
* An NPN transistor set by its current gain: pins C B E; 0.65 V base to emitter at 1 mA of collector current
Q1 1 2 3 QM
.MODEL QM NPN(BF={BF} IS={1m/(exp(0.65/0.025865)-1)} VAF={VAF} BR=1 RB=10 CJC=4p CJE=8p TF=400p)
.ENDS NPN_BETA`,
  'PNP_BETA.ckt': `.SUBCKT PNP_BETA 1 2 3 PARAMS: BF=100 VAF=100
* A PNP transistor set by its current gain: pins C B E
Q1 1 2 3 QM
.MODEL QM PNP(BF={BF} IS={1m/(exp(0.65/0.025865)-1)} VAF={VAF} BR=1 RB=10 CJC=4p CJE=8p TF=400p)
.ENDS PNP_BETA`,
  'DARLINGTON.ckt': `.SUBCKT DARLINGTON 1 2 3 PARAMS: BF=10k
* A Darlington pair of NPN transistors: pins C B E, its current gain BF in all
Q1 1 2 10 QM
Q2 1 10 3 QM
.MODEL QM NPN(BF={sqrt(BF)} IS={1m/(exp(0.65/0.025865)-1)} VAF=100 BR=1 RB=10 CJC=4p CJE=8p TF=400p)
.ENDS DARLINGTON`,
  'NMOS_VT.ckt': `.SUBCKT NMOS_VT 1 2 3 PARAMS: VT=1.5 KP=0.5
* An N-channel MOSFET set by its threshold voltage and its beta (A/V2): pins D G S
M1 1 2 3 3 MM
.MODEL MM NMOS(LEVEL=1 VTO={VT} KP={KP} LAMBDA=10m CBD=5p CBS=5p CGSO=1n CGDO=0.2n)
.ENDS NMOS_VT`,
  'PMOS_VT.ckt': `.SUBCKT PMOS_VT 1 2 3 PARAMS: VT=1.5 KP=0.5
* A P-channel MOSFET set by its threshold voltage (given as a positive figure) and its beta: pins D G S
M1 1 2 3 3 MM
.MODEL MM PMOS(LEVEL=1 VTO={-abs(VT)} KP={KP} LAMBDA=10m CBD=5p CBS=5p CGSO=1n CGDO=0.2n)
.ENDS PMOS_VT`,
  'NJFET.ckt': `.SUBCKT NJFET 1 2 3 PARAMS: VP=2 IDSS=5m
* An N-channel JFET set by its pinch-off voltage (a positive figure) and its saturation current: pins D G S
J1 1 2 3 JM
.MODEL JM NJF(VTO={-abs(VP)} BETA={IDSS/(VP*VP)} LAMBDA=5m IS=1f CGD=2p CGS=2p)
.ENDS NJFET`,
  'PJFET.ckt': `.SUBCKT PJFET 1 2 3 PARAMS: VP=2 IDSS=5m
* A P-channel JFET set by its pinch-off voltage and its saturation current: pins D G S
J1 1 2 3 JM
.MODEL JM PJF(VTO={-abs(VP)} BETA={IDSS/(VP*VP)} LAMBDA=5m IS=1f CGD=2p CGS=2p)
.ENDS PJFET`,
  'POT.ckt': `.SUBCKT POT 1 2 3 PARAMS: R=10k POS=50
* A potentiometer: its track from 1 to 2, its wiper 3 at POS per cent of the way from 2 to 1
R1 1 3 {R*(100-limit(POS, 0, 100))/100+1m}
R2 3 2 {R*limit(POS, 0, 100)/100+1m}
.ENDS POT`,
  'SWITCH_SPDT.ckt': `.SUBCKT SWITCH_SPDT 1 2 3 PARAMS: RA=1m RB=1G
* A changeover switch: its common 1 to 2 through RA, to 3 through RB (the sheet gives the one closed its on resistance)
R1 1 2 {RA}
R2 1 3 {RB}
.ENDS SWITCH_SPDT`,
  'TRANSFORMER.ckt': `.SUBCKT TRANSFORMER 1 2 3 4 PARAMS: LP=100m RATIO=1 K=0.999
* Two coupled windings: the primary 1-2 of LP, the secondary 3-4 of LP over the turns ratio squared,
* each with 10 milliohms of its own (so that a source straight across one has something to drive at DC)
R1 1 10 10m
L1 10 2 {LP}
R2 3 11 10m
L2 11 4 {LP/(RATIO*RATIO)}
K1 L1 L2 {K}
RISO 2 4 1G
.ENDS TRANSFORMER`,
  'RELAY.ckt': `.SUBCKT RELAY 1 2 3 4 PARAMS: RCOIL=200 LCOIL=20m ION=20m IOFF=10m RON=50m ROFF=1G
* A relay: its coil 1-2, its contact 3-4 closed once the coil's current (either way) reaches ION, open again below IOFF
VS 1 10 0
L1 10 11 {LCOIL}
R1 11 2 {RCOIL}
B1 20 0 V={abs(I(VS))}
R2 20 0 1k
S1 3 4 20 0 SM
.MODEL SM SW(VT={(ION+IOFF)/2} VH={(ION-IOFF)/2} RON={RON} ROFF={ROFF})
RISO 2 4 1G
.ENDS RELAY`,
  'XTAL.ckt': `.SUBCKT XTAL 1 2 PARAMS: F=1MEG CS=10f RS=50 CP=5p
* A crystal: series L, CS and RS resonant at F, with CP across them
L1 1 10 {1/(39.47842*F*F*CS)}
C1 10 11 {CS}
R1 11 2 {RS}
C0 1 2 {CP}
.ENDS XTAL`,
  'CCVS.ckt': `.SUBCKT CCVS 1 2 3 4 PARAMS: GAIN=1k
* A current-controlled voltage source: the current from 1 to 2 (through no resistance) sets the voltage 3-4
VS 1 2 0
H1 3 4 VS {GAIN}
.ENDS CCVS`,
  'CCCS.ckt': `.SUBCKT CCCS 1 2 3 4 PARAMS: GAIN=10
* A current-controlled current source: the current from 1 to 2 sets the current from 3 to 4
VS 1 2 0
F1 3 4 VS {GAIN}
.ENDS CCCS`,
  'ANALOG_SWITCH.ckt': `.SUBCKT ANALOG_SWITCH 1 2 3 PARAMS: VT=2.5 RON=20 ROFF=1G
* An analogue switch: 1 to 2 closed while the control 3 is above VT
S1 1 2 3 0 SM
.MODEL SM SW(VT={VT} VH=0.05 RON={RON} ROFF={ROFF})
RC 3 0 1G
.ENDS ANALOG_SWITCH`,
  // Logic and chips: gates as one source each (smooth about the threshold, so that the solver follows them), a timer, a regulator
  'LOGIC_IN.ckt': `.SUBCKT LOGIC_IN 1 PARAMS: RA=1G RB=1 VH=5
* A logic input: its pin at VH through RA or at 0 V through RB (the sheet makes one of them small: its picture is its state)
V1 10 0 {VH}
R1 10 1 {RA}
R2 1 0 {RB}
.ENDS LOGIC_IN`,
  'GATE_NOT.ckt': `.SUBCKT GATE_NOT 1 2 PARAMS: VDD=5
* An inverter: pins IN OUT. High is VDD; an input counts as high above half of it
B1 10 0 V={VDD*(1-0.5*(1+tanh(40*(V(1)/VDD-0.5))))}
ROUT 10 2 50
COUT 2 0 20p
RIN1 1 0 1G
.ENDS GATE_NOT`,
  'GATE_AND.ckt': `.SUBCKT GATE_AND 1 2 3 PARAMS: VDD=5
* An AND gate: pins A B OUT. High is VDD; an input counts as high above half of it
B1 10 0 V={VDD*(0.5*(1+tanh(40*(V(1)/VDD-0.5)))*0.5*(1+tanh(40*(V(2)/VDD-0.5))))}
ROUT 10 3 50
COUT 3 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.ENDS GATE_AND`,
  'GATE_NAND.ckt': `.SUBCKT GATE_NAND 1 2 3 PARAMS: VDD=5
* A NAND gate: pins A B OUT. High is VDD; an input counts as high above half of it
B1 10 0 V={VDD*(1-0.5*(1+tanh(40*(V(1)/VDD-0.5)))*0.5*(1+tanh(40*(V(2)/VDD-0.5))))}
ROUT 10 3 50
COUT 3 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.ENDS GATE_NAND`,
  'GATE_OR.ckt': `.SUBCKT GATE_OR 1 2 3 PARAMS: VDD=5
* An OR gate: pins A B OUT. High is VDD; an input counts as high above half of it
B1 10 0 V={VDD*(1-(1-0.5*(1+tanh(40*(V(1)/VDD-0.5))))*(1-0.5*(1+tanh(40*(V(2)/VDD-0.5)))))}
ROUT 10 3 50
COUT 3 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.ENDS GATE_OR`,
  'GATE_NOR.ckt': `.SUBCKT GATE_NOR 1 2 3 PARAMS: VDD=5
* A NOR gate: pins A B OUT. High is VDD; an input counts as high above half of it
B1 10 0 V={VDD*((1-0.5*(1+tanh(40*(V(1)/VDD-0.5))))*(1-0.5*(1+tanh(40*(V(2)/VDD-0.5)))))}
ROUT 10 3 50
COUT 3 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.ENDS GATE_NOR`,
  'GATE_XOR.ckt': `.SUBCKT GATE_XOR 1 2 3 PARAMS: VDD=5
* An exclusive-OR gate: pins A B OUT. High is VDD; an input counts as high above half of it
B1 10 0 V={VDD*(0.5*(1+tanh(40*(V(1)/VDD-0.5)))+0.5*(1+tanh(40*(V(2)/VDD-0.5)))-2*0.5*(1+tanh(40*(V(1)/VDD-0.5)))*0.5*(1+tanh(40*(V(2)/VDD-0.5))))}
ROUT 10 3 50
COUT 3 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.ENDS GATE_XOR`,
  'SCHMITT_NOT.ckt': `.SUBCKT SCHMITT_NOT 1 2 PARAMS: VDD=5 VP=3 VN=2
* A Schmitt-trigger inverter: pins IN OUT. The output goes low as the input rises past VP and high as it falls past VN
VS 10 0 {VDD}
RP 10 11 1k
S1 11 0 1 0 SM
.MODEL SM SW(VT={(VP+VN)/2} VH={(VP-VN)/2} RON=1m ROFF=1G)
E1 12 0 11 0 1
ROUT 12 2 50
COUT 2 0 20p
RIN 1 0 1G
.ENDS SCHMITT_NOT`,
  'NE555.ckt': `.SUBCKT NE555 1 2 3 4 5 6 7 8
* A 555 timer by what it does: pins GND TRIG OUT RESET CTRL THR DIS VCC.
* Three 5 k resistors set CTRL at two thirds of the supply and the trigger level at one third.
* Node 20 says what is asked of the latch: 1 while TRIG is under a third (set), 0 while THR is over CTRL and it is
* not being set, or RESET is low (cleared), and 0.5 while nothing is asked. The latch is the switch S1, which turns on
* above 0.6, off below 0.4 and stays as it is between: node 24 is its state, 1 or 0.
* The output is within 1.4 V of the supply while it is set; DIS is pulled to GND (through 15 ohms) while it is not.
R1 8 5 5k
R2 5 10 5k
R3 10 1 5k
B1 20 0 V={0.5+0.25*(1+tanh(200*(V(10)-V(2))))-0.125*(1-tanh(200*(V(10)-V(2))))*(1+tanh(200*(V(6)-V(5))))-0.5*(1-tanh(20*(V(4)-V(1)-0.7)))}
VQ 23 0 1
S1 23 24 20 0 SQ
.MODEL SQ SW(VT=0.5 VH=0.1 RON=1m ROFF=1T)
RQ 24 0 1k
B2 21 1 V={max(V(8)-V(1)-1.4, 0)*V(24)}
ROUT 21 3 10
B3 7 1 I={(V(7)-V(1))/15*(1-V(24))}
RT 2 1 1G
RH 6 1 1G
RD 7 1 1G
RR 4 8 100k
.ENDS NE555`,
  'REGULATOR.ckt': `.SUBCKT REGULATOR 1 2 3 PARAMS: VOUT=5 DROP=2
* A voltage regulator by what it does: pins IN GND OUT. The output is held at VOUT above GND while the input is DROP
* or more above that, and follows the input down below it. The load's current is taken from IN (F1 passes on what
* the output source gives), and a milliampere or two goes to GND
B1 10 2 V={limit(V(1)-V(2)-DROP, 0, VOUT)}
VS 10 11 0
ROUT 11 3 50m
F1 1 2 VS 1
RQ 1 2 5k
.ENDS REGULATOR`,
  'OPTO.ckt': `.SUBCKT OPTO 1 2 3 4 PARAMS: CTR=100 VF=1.2
* An optocoupler: pins A K C E. The LED's current times CTR per cent flows from C to E while there is voltage for it
VS 1 10 0
D1 10 2 DM
.MODEL DM D(IS={10m/(exp((VF-10m)/(2*0.025865))-1)} N=2 RS=1 BV=6 IBV=1m)
B1 3 4 I={CTR/100*max(I(VS), 0)*limit(tanh((V(3)-V(4))/0.2), 0, 1)}
RO 3 4 100Meg
RISO 2 4 1G
.ENDS OPTO`,
  // Flip-flops, a counter and a display: a bit is kept by a switch with hysteresis, which the solver steps through cleanly
  'DFF.ckt': `.SUBCKT DFF 1 2 3 4 PARAMS: VDD=5
* A D flip-flop: pins D CLK Q QN. Q takes what D is as the clock rises
* Two latches, each a switch that turns on above 0.75, off below 0.25 and stays as it is between (node 11 the master's
* state, node 21 the slave's, 1 or 0). The master takes what is asked while the clock is low and holds while it is high;
* the slave takes the master's state while the clock is high: the output changes as the clock rises.
VONE 90 0 1
B1 10 0 V={0.5+0.5*(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(2*(0.5*(1+tanh(40*(V(1)/VDD-0.5))))-1)}
S1 90 11 10 0 SM
R1 11 0 1k
B2 20 0 V={0.5+0.5*0.5*(1+tanh(40*(V(2)/VDD-0.5)))*(2*V(11)-1)}
S2 90 21 20 0 SM
R2 21 0 1k
B3 30 0 V={VDD*V(21)}
ROUT3 30 3 50
COUT3 3 0 20p
B4 31 0 V={VDD*(1-V(21))}
ROUT4 31 4 50
COUT4 4 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.MODEL SM SW(VT=0.5 VH=0.25 RON=1m ROFF=1T)
.ENDS DFF`,
  'JKFF.ckt': `.SUBCKT JKFF 1 2 3 4 5 PARAMS: VDD=5
* A JK flip-flop: pins J CLK K Q QN. As the clock rises: J sets, K clears, both turn it over, neither leaves it
* Two latches, each a switch that turns on above 0.75, off below 0.25 and stays as it is between (node 11 the master's
* state, node 21 the slave's, 1 or 0). The master takes what is asked while the clock is low and holds while it is high;
* the slave takes the master's state while the clock is high: the output changes as the clock rises.
VONE 90 0 1
B1 10 0 V={0.5+0.5*(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(2*(0.5*(1+tanh(40*(V(1)/VDD-0.5)))*(1-V(21))+(1-0.5*(1+tanh(40*(V(3)/VDD-0.5))))*V(21))-1)}
S1 90 11 10 0 SM
R1 11 0 1k
B2 20 0 V={0.5+0.5*0.5*(1+tanh(40*(V(2)/VDD-0.5)))*(2*V(11)-1)}
S2 90 21 20 0 SM
R2 21 0 1k
B3 30 0 V={VDD*V(21)}
ROUT4 30 4 50
COUT4 4 0 20p
B4 31 0 V={VDD*(1-V(21))}
ROUT5 31 5 50
COUT5 5 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
RIN3 3 0 1G
.MODEL SM SW(VT=0.5 VH=0.25 RON=1m ROFF=1T)
.ENDS JKFF`,
  'TFF.ckt': `.SUBCKT TFF 1 2 3 4 PARAMS: VDD=5
* A T flip-flop: pins T CLK Q QN. Q turns over as the clock rises while T is high
* Two latches, each a switch that turns on above 0.75, off below 0.25 and stays as it is between (node 11 the master's
* state, node 21 the slave's, 1 or 0). The master takes what is asked while the clock is low and holds while it is high;
* the slave takes the master's state while the clock is high: the output changes as the clock rises.
VONE 90 0 1
B1 10 0 V={0.5+0.5*(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(2*(0.5*(1+tanh(40*(V(1)/VDD-0.5)))+V(21)-2*0.5*(1+tanh(40*(V(1)/VDD-0.5)))*V(21))-1)}
S1 90 11 10 0 SM
R1 11 0 1k
B2 20 0 V={0.5+0.5*0.5*(1+tanh(40*(V(2)/VDD-0.5)))*(2*V(11)-1)}
S2 90 21 20 0 SM
R2 21 0 1k
B3 30 0 V={VDD*V(21)}
ROUT3 30 3 50
COUT3 3 0 20p
B4 31 0 V={VDD*(1-V(21))}
ROUT4 31 4 50
COUT4 4 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.MODEL SM SW(VT=0.5 VH=0.25 RON=1m ROFF=1T)
.ENDS TFF`,
  'COUNTER.ckt': `.SUBCKT COUNTER 1 2 3 4 5 6 PARAMS: VDD=5 MODULUS=16
* A four-bit counter: pins CLK RST Q0 Q1 Q2 Q3. It counts up as the clock rises, from 0 to MODULUS-1 and round again
* (MODULUS=10 counts in tens); RST high clears it at once. Node 70 is the count, node 71 the next one; each bit is a
* master and a slave latch as in the flip-flops (nodes 20, 22, 24, 26 the masters, 21, 23, 25, 27 the slaves).
VONE 90 0 1
BQ 70 0 V={round(V(21))+2*round(V(23))+4*round(V(25))+8*round(V(27))}
BN 71 0 V={mod(V(70)+1, max(2, min(16, round(MODULUS))))}
BM0 40 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*(1-0.5*(1+tanh(40*(V(1)/VDD-0.5))))*(2*bit(V(71),0)-1))}
SM0 90 20 40 0 SM
RM0 20 0 1k
BS0 41 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*0.5*(1+tanh(40*(V(1)/VDD-0.5)))*(2*V(20)-1))}
SS0 90 21 41 0 SM
RS0 21 0 1k
BO0 60 0 V={VDD*V(21)}
ROUT0 60 3 50
COUT0 3 0 20p
BM1 42 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*(1-0.5*(1+tanh(40*(V(1)/VDD-0.5))))*(2*bit(V(71),1)-1))}
SM1 90 22 42 0 SM
RM1 22 0 1k
BS1 43 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*0.5*(1+tanh(40*(V(1)/VDD-0.5)))*(2*V(22)-1))}
SS1 90 23 43 0 SM
RS1 23 0 1k
BO1 61 0 V={VDD*V(23)}
ROUT1 61 4 50
COUT1 4 0 20p
BM2 44 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*(1-0.5*(1+tanh(40*(V(1)/VDD-0.5))))*(2*bit(V(71),2)-1))}
SM2 90 24 44 0 SM
RM2 24 0 1k
BS2 45 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*0.5*(1+tanh(40*(V(1)/VDD-0.5)))*(2*V(24)-1))}
SS2 90 25 45 0 SM
RS2 25 0 1k
BO2 62 0 V={VDD*V(25)}
ROUT2 62 5 50
COUT2 5 0 20p
BM3 46 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*(1-0.5*(1+tanh(40*(V(1)/VDD-0.5))))*(2*bit(V(71),3)-1))}
SM3 90 26 46 0 SM
RM3 26 0 1k
BS3 47 0 V={(1-0.5*(1+tanh(40*(V(2)/VDD-0.5))))*(0.5+0.5*0.5*(1+tanh(40*(V(1)/VDD-0.5)))*(2*V(26)-1))}
SS3 90 27 47 0 SM
RS3 27 0 1k
BO3 63 0 V={VDD*V(27)}
ROUT3 63 6 50
COUT3 6 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
.MODEL SM SW(VT=0.5 VH=0.25 RON=1m ROFF=1T)
.ENDS COUNTER`,
  'DECODER7.ckt': `.SUBCKT DECODER7 1 2 3 4 5 6 7 8 9 10 11 PARAMS: VDD=5
* A seven-segment decoder: pins A B C D (the number, A its ones) and a b c d e f g (high for a lit segment).
* 10 to 15 show as A, b, C, d, E, F
BV 20 0 V={0.5*(1+tanh(40*(V(1)/VDD-0.5)))+2*0.5*(1+tanh(40*(V(2)/VDD-0.5)))+4*0.5*(1+tanh(40*(V(3)/VDD-0.5)))+8*0.5*(1+tanh(40*(V(4)/VDD-0.5)))}
Ba 30 0 V={VDD*seg7(V(20),0)}
ROUTa 30 5 50
COUTa 5 0 20p
Bb 31 0 V={VDD*seg7(V(20),1)}
ROUTb 31 6 50
COUTb 6 0 20p
Bc 32 0 V={VDD*seg7(V(20),2)}
ROUTc 32 7 50
COUTc 7 0 20p
Bd 33 0 V={VDD*seg7(V(20),3)}
ROUTd 33 8 50
COUTd 8 0 20p
Be 34 0 V={VDD*seg7(V(20),4)}
ROUTe 34 9 50
COUTe 9 0 20p
Bf 35 0 V={VDD*seg7(V(20),5)}
ROUTf 35 10 50
COUTf 10 0 20p
Bg 36 0 V={VDD*seg7(V(20),6)}
ROUTg 36 11 50
COUTg 11 0 20p
RIN1 1 0 1G
RIN2 2 0 1G
RIN3 3 0 1G
RIN4 4 0 1G
.ENDS DECODER7`,
  'DISPLAY7.ckt': `.SUBCKT DISPLAY7 1 2 3 4 5 6 7 8 PARAMS: VF=1.8 IF=10m RS=220
* A seven-segment display with a common cathode: pins a b c d e f g and K. Each segment is an LED (VF across it at IF)
* behind a resistor RS of its own, so that a logic output drives it as it is
Ra 1 11 {RS}
Da 11 8 DM
Rb 2 12 {RS}
Db 12 8 DM
Rc 3 13 {RS}
Dc 13 8 DM
Rd 4 14 {RS}
Dd 14 8 DM
Re 5 15 {RS}
De 15 8 DM
Rf 6 16 {RS}
Df 16 8 DM
Rg 7 17 {RS}
Dg 17 8 DM
.MODEL DM D(IS={IF/(exp((VF-IF)/(2*0.025865))-1)} N=2 RS=1 BV=5 IBV=1m CJO=2p)
.ENDS DISPLAY7`,
  'FUSE.ckt': `.SUBCKT FUSE 1 2 PARAMS: RATING=1 R=10m
* A fuse: its resistance R until the current through it passes RATING, open from then on. Its state is a switch that
* turns on above the rating and never off again (it would take less than no current); node 22 is 1 once it has blown.
* The run's From the Start, or a click on it in Live Simulation, makes it good.
VS 1 10 0
B1 20 0 V={abs(I(VS))}
S1 10 2 20 0 SF
.MODEL SF SW(VT=0 VH={RATING} RON=1G ROFF={R})
VONE 21 0 1
S2 21 22 20 0 SQ
.MODEL SQ SW(VT=0 VH={RATING} RON=1m ROFF=1G)
RQ 22 0 1k
.ENDS FUSE`,
  'SCR.ckt': `.SUBCKT SCR 1 2 3 PARAMS: IGT=5m IH=5m
* A thyristor (SCR) by what it does: pins A K G. It turns on when the gate's current passes IGT, stays on while the
* anode's current is over IH, and turns off when that falls below. Node 20 says what is asked of it: over 0.75 on,
* 0.5 stay as you are, under 0.25 off. It conducts one way, with about a volt across it.
VS 1 10 0
S1 10 11 20 0 SM
D1 11 2 DM
VG 3 12 0
RG 12 13 50
DG 13 2 DGK
B1 20 0 V={max(0.5*(1+tanh(4*(I(VG)/IGT-1))), 0.25*(1+tanh(4*(I(VS)/IH-1))))}
.MODEL SM SW(VT=0.5 VH=0.25 RON=10m ROFF=100Meg)
.MODEL DM D(IS=1e-12 N=1.5 RS=20m)
.MODEL DGK D(IS=1e-12 N=1.5)
.ENDS SCR`,
  'TRIAC.ckt': `.SUBCKT TRIAC 1 2 3 PARAMS: IGT=5m IH=5m
* A TRIAC by what it does: pins MT2 MT1 G. As the thyristor, but either way round: gate current of either sign past
* IGT turns it on, and it stays on while the current through it, either way, is over IH.
VS 1 10 0
S1 10 11 20 0 SM
D1 11 2 DM
D2 2 11 DM
VG 3 12 0
RG 12 13 50
DG1 13 2 DGK
DG2 2 13 DGK
B1 20 0 V={max(0.5*(1+tanh(4*(abs(I(VG))/IGT-1))), 0.25*(1+tanh(4*(abs(I(VS))/IH-1))))}
.MODEL SM SW(VT=0.5 VH=0.25 RON=10m ROFF=100Meg)
.MODEL DM D(IS=1e-12 N=1.5 RS=20m)
.MODEL DGK D(IS=1e-12 N=1.5)
.ENDS TRIAC`,
};

/* ─── Chips and parts written out by rule (26.186) ─────────────────────────────────── */

/** A logic input's level, 0 to 1: a smooth step at half the supply. */
const HI = (node: number | string): string => `0.5*(1+tanh(40*(V(${node})/VDD-0.5)))`;
/**
 * One bit, a master and a slave latch as in the flip-flops and the counter: the master (node `m`) takes `x` (an
 * expression, 0 to 1) while the clock (pin `clk`) is low, the slave (node `s`) takes the master as the clock rises;
 * pin `rst` high clears both. Their controls are nodes m + 100 and s + 100; node 90 is the 1 V the latches switch.
 */
const bitStage = (k: number, m: number, s: number, x: string, clk: number, rst: number): string[] => [
  `BM${k} ${m + 100} 0 V={(1-${HI(rst)})*(0.5+0.5*(1-${HI(clk)})*(2*(${x})-1))}`, `SM${k} 90 ${m} ${m + 100} 0 SM`, `RM${k} ${m} 0 1k`,
  `BS${k} ${s + 100} 0 V={(1-${HI(rst)})*(0.5+0.5*${HI(clk)}*(2*V(${m})-1))}`, `SS${k} 90 ${s} ${s + 100} 0 SM`, `RS${k} ${s} 0 1k`,
];
/** A logic output: `expr` (volts) behind 50 ohms, with 20 pF on the pin. */
const outStage = (name: string, node: number, pin: number, expr: string): string[] => [`BO${name} ${node} 0 V={${expr}}`, `ROUT${name} ${node} ${pin} 50`, `COUT${name} ${pin} 0 20p`];
const LATCH_MODEL = '.MODEL SM SW(VT=0.5 VH=0.25 RON=1m ROFF=1T)';
const inputs = (pins: number[]): string[] => pins.map((p) => `RIN${p} ${p} 0 1G`);

Object.assign(BUILTIN_MODELS, {
  // A four-bit shift register, serial in and parallel out
  'SHIFT.ckt': [
    '.SUBCKT SHIFT 1 2 3 4 5 6 7 PARAMS: VDD=5',
    '* A four-bit shift register: pins D CLK RST Q0 Q1 Q2 Q3. As the clock rises Q0 takes what D is and each other bit',
    '* what the one before it was; RST high clears it. Each bit is a master and a slave latch (nodes 20, 22, 24, 26 the',
    '* masters, 21, 23, 25, 27 the slaves).',
    'VONE 90 0 1',
    ...[0, 1, 2, 3].flatMap((k) => [...bitStage(k, 20 + 2 * k, 21 + 2 * k, k ? `V(${19 + 2 * k})` : HI(1), 2, 3), ...outStage(String(k), 60 + k, 4 + k, `VDD*V(${21 + 2 * k})`)]),
    ...inputs([1, 2, 3]), LATCH_MODEL, '.ENDS SHIFT',
  ].join('\n'),
  // A ring counter: one output high at a time, the next as the clock rises (the 4017's way)
  'RING.ckt': [
    '.SUBCKT RING 1 2 3 4 5 6 7 8 9 10 11 12 PARAMS: VDD=5 STAGES=10',
    '* A ring counter: pins CLK RST Q0 to Q9. One output is high at a time: Q0 after RST, and the next one as the clock',
    '* rises, round again after STAGES of them (2 to 10). Inside it is the counter (node 70 the count, 71 the next) with',
    '* each output high while the count is its own.',
    'VONE 90 0 1',
    'BQ 70 0 V={round(V(21))+2*round(V(23))+4*round(V(25))+8*round(V(27))}',
    'BN 71 0 V={mod(V(70)+1, max(2, min(10, round(STAGES))))}',
    ...[0, 1, 2, 3].flatMap((k) => bitStage(k, 20 + 2 * k, 21 + 2 * k, `bit(V(71),${k})`, 1, 2)),
    ...Array.from({ length: 10 }, (_, k) => outStage(String(k), 50 + k, 3 + k, `VDD*(abs(V(70)-${k})<0.5)`)).flat(),
    ...inputs([1, 2]), LATCH_MODEL, '.ENDS RING',
  ].join('\n'),
  // A four-way multiplexer of logic levels
  'MUX4.ckt': [
    '.SUBCKT MUX4 1 2 3 4 5 6 7 PARAMS: VDD=5',
    '* A multiplexer: pins I0 I1 I2 I3 S0 S1 Q. Q is the input that S1 and S0 name (S0 the ones), as a logic level.',
    ...outStage('', 20, 7, `VDD*((1-${HI(6)})*((1-${HI(5)})*${HI(1)}+${HI(5)}*${HI(2)})+${HI(6)}*((1-${HI(5)})*${HI(3)}+${HI(5)}*${HI(4)}))`),
    ...inputs([1, 2, 3, 4, 5, 6]), '.ENDS MUX4',
  ].join('\n'),
  // Four bits to a voltage, and a voltage to four bits
  'DAC4.ckt': [
    '.SUBCKT DAC4 1 2 3 4 5 PARAMS: VDD=5 VREF=5',
    '* A four-bit digital-to-analogue converter: pins D0 D1 D2 D3 OUT (D0 the ones). OUT is VREF times the number over 16:',
    '* 0 V for 0000, 15/16 of VREF for 1111.',
    `BO 20 0 V={VREF*(${HI(1)}+2*${HI(2)}+4*${HI(3)}+8*${HI(4)})/16}`, 'ROUT 20 5 50', 'COUT 5 0 20p',
    ...inputs([1, 2, 3, 4]), '.ENDS DAC4',
  ].join('\n'),
  'ADC4.ckt': [
    '.SUBCKT ADC4 1 2 3 4 5 PARAMS: VDD=5 VREF=5',
    '* A four-bit analogue-to-digital converter (a flash one: no clock): pins IN D0 D1 D2 D3 (D0 the ones). The number is',
    '* IN over VREF in sixteenths, rounded down, from 0 (under a sixteenth of VREF) to 15 (fifteen sixteenths and over).',
    '* (A voltage that stands on a step to the last digit counts as on it: a billionth of a step is added before rounding.)',
    'BC 20 0 V={max(0, min(15, floor(16*V(1)/VREF+1e-9)))}',
    ...[0, 1, 2, 3].flatMap((k) => outStage(String(k), 30 + k, 2 + k, `VDD*bit(V(20),${k})`)),
    'RIN1 1 0 1G', '.ENDS ADC4',
  ].join('\n'),
  // A DIAC: breaks over either way round
  'DIAC.ckt': `.SUBCKT DIAC 1 2 PARAMS: VBO=32 DV=8 IH=1m
* A DIAC by what it does: it blocks either way until the voltage across it passes VBO, then conducts with DV less
* than that across it, and blocks again when its current falls below IH. Node 20 says what is asked of it (over 0.75
* on, 0.5 stay as you are, under 0.25 off); when on, each way is a diode behind a source of the voltage it keeps.
VS 1 10 0
B1 20 0 V={max(0.5*(1+tanh(8*(abs(V(1,2))/VBO-1))), 0.25*(1+tanh(4*(abs(I(VS))/IH-1))))}
S1 10 11 20 0 SM
D1 11 12 DM
V1 12 2 {max(0, VBO-DV-0.7)}
S2 2 13 20 0 SM
D2 13 14 DM
V2 14 10 {max(0, VBO-DV-0.7)}
RLEAK 1 2 100Meg
.MODEL SM SW(VT=0.5 VH=0.25 RON=1 ROFF=100Meg)
.MODEL DM D(IS=1e-12 N=1.5 RS=2)
.ENDS DIAC`,
  // A fuse that takes its time
  'FUSE_SLOW.ckt': `.SUBCKT FUSE_SLOW 1 2 PARAMS: RATING=1 R=10m TAU=1
* A slow-blow fuse: its resistance R until it has been heated through, open from then on. Node 30 is its heat: the
* square of the current over the rating, followed with the time constant TAU, so that the rating held for ever just
* fails to blow it, twice the rating blows it in 0.29 of TAU and ten times in a hundredth. Its state is the fuse's:
* a switch that turns on at 1 and never off again; node 22 is 1 once it has blown.
VS 1 10 0
BH 0 30 I={(I(VS)/RATING)^2}
RH 30 0 1
CH 30 0 {TAU}
B1 20 0 V={V(30)}
S1 10 2 20 0 SF
.MODEL SF SW(VT=0 VH=1 RON=1G ROFF={R})
VONE 21 0 1
S2 21 22 20 0 SQ
.MODEL SQ SW(VT=0 VH=1 RON=1m ROFF=1G)
R22 22 0 1k
.ENDS FUSE_SLOW`,
});

/** A built-in model file by name (case-insensitive), with or without its extension. */
export function builtinModel(file: string): { name: string; text: string } | null {
  const want = file.split(/[\\/]/).pop()!.toLowerCase();
  for (const [name, text] of Object.entries(BUILTIN_MODELS)) {
    const n = name.toLowerCase();
    if (n === want || n.replace(/\.(mdl|ckt)$/, '') === want) return { name, text };
  }
  return null;
}
