/* node_helper.js
 *
 * Magic Mirror module - Display public transport in Stockholm/Sweden.
 * This module use the API's provided by Trafiklab.
 *
 * Magic Mirror
 * Module: MMM-SL-PublicTransport
 *
 * Magic Mirror By Michael Teeuw http://michaelteeuw.nl
 * MIT Licensed.
 *
 * Module MMM-SL-PublicTransport By Anders Boghammar
 */
const NodeHelper = require("node_helper");
const request = require("request-promise");
const HttpsProxyAgent = require('https-proxy-agent');
const Url = require('url');
const Departure = require('./departure.js');
let debugModeEnabled = false;

module.exports = NodeHelper.create({

    // --------------------------------------- Start the helper
    start: function () {
        //Log.info('Starting helper: '+ this.name);
        log('Starting helper: ' + this.name);
        this.started = false;
    },

    // --------------------------------------- Schedule a departure update
    scheduleUpdate: function () {
        const self = this;
        debug('scheduleUpdate=' + self.getNextUpdateInterval());
        this.updatetimer = setInterval(function () { // This timer is saved in uitimer so that we can cancel it
            self.getDepartures();
        }, self.getNextUpdateInterval());
    },

    // --------------------------------------- Retrive departure info
    getDepartures: function () {
        const self = this;

        clearInterval(this.updatetimer); // Clear the timer so that we can set it again

        //debug("stationid is array="+Array.isArray(this.config.stationid));
        const promisesToHandle = [];
        // Loop over all stations
        if (this.config.stations === undefined) {
            debug('Stations not defined ');
            self.sendSocketNotification('SERVICE_FAILURE', {
                resp: {
                    Message: 'config.stations is not defined',
                    StatusCode: 500
                }
            });
        } else {
            this.config.stations.forEach(station => {
                const getDeparturePromise = new Promise((resolve, reject) => {
                    self.getDeparture(station, resolve, reject);
                });
                debug('Pushing promise for station ' + station.stationId);
                console.log(getDeparturePromise);
                promisesToHandle.push(getDeparturePromise);
            });

            Promise.all(promisesToHandle).then(CurrentDeparturesArray => {
                debug('all promises resolved ' + CurrentDeparturesArray);
                self.sendSocketNotification('DEPARTURES', CurrentDeparturesArray); // Send departures to module
            }).catch(reason => {
                debug('One or more promises rejected ' + reason);
                self.sendSocketNotification('SERVICE_FAILURE', reason);
            });
        }

        self.scheduleUpdate(); // reinitiate the timer
    },

    // --------------------------------------- Get departures for one station
    // The CurrentDepartures object holds this data
    //  CurrentDepartures = {
    //      StationId: string
    //      LatestUpdate: date,     // When the realtime data was updated
    //      DataAge: ??,            // The age of the data in ??
    //      departures: [dir][deps] // An array of array of Departure objects
    //  }
    getDeparture: function (station, resolve, reject) {
        log('Getting departures for station id ' + station.stationId);
        const self = this;

        // http://api.sl.se/api2/realtimedeparturesV4.<FORMAT>?key=<DIN API
        // NYCKEL>&siteid=<SITEID>&timewindow=<TIMEWINDOW>
        const transport = (this.config.SSL ? 'https' : 'http');
        const opt = {
            uri: transport + '://api.sl.se/api2/realtimedeparturesV4.json',
            qs: {
                key: this.config.apikey,
                siteid: station.stationId,
                timewindow: 60
            },
            json: true
        };

        // Exclude those types of rides that you are not interested in
        if (station.excludeTransportTypes !== undefined && Array.isArray(station.excludeTransportTypes)) {
            for (var ix = 0; ix < station.excludeTransportTypes.length; ix++) {
                opt.qs[station.excludeTransportTypes[ix]] = false
            }
        }

        if (this.config.proxy !== undefined) {
            opt.agent = new HttpsProxyAgent(Url.parse(this.config.proxy));
            debug('SL-PublicTransport: Using proxy ' + this.config.proxy);
        }
        debug('SL-PublicTransport: station id ' + station.stationId + ' Calling ' + opt.uri);
        console.log(opt);
        request(opt)
            .then(function (resp) {
                if (resp.StatusCode !== 0) {
                    log('Something went wrong: station id=' + station.stationId + ' StatusCode: ' + resp.StatusCode + ' Msg: ' + resp.Message);
                    reject(resp);
                    return;
                }

                //console.log(resp);
                const CurrentDepartures = {};
                const departures = [];
                CurrentDepartures.StationId = station.stationId;
                CurrentDepartures.StationName = (station.stationName === undefined ? 'NotSet' : station.stationName);
                CurrentDepartures.LatestUpdate = resp.ResponseData.LatestUpdate; // Anger när realtidsinformationen
                                                                                 // (DPS) senast uppdaterades.
                CurrentDepartures.DataAge = resp.ResponseData.DataAge; //Antal sekunder sedan tidsstämpeln
                                                                       // LatestUpdate.
                CurrentDepartures.obtained = new Date(); //When we got it.
                self.addDepartures(station, departures, resp.ResponseData.Metros);
                self.addDepartures(station, departures, resp.ResponseData.Buses);
                self.addDepartures(station, departures, resp.ResponseData.Trains);
                self.addDepartures(station, departures, resp.ResponseData.Trams);
                self.addDepartures(station, departures, resp.ResponseData.Ships);

                // Sort on ExpectedDateTime
                for (var ix = 0; ix < departures.length; ix++) {
                    if (departures[ix] !== undefined) {
                        departures[ix].sort(dynamicSort('ExpectedDateTime'))
                    }
                }

                // Add the sorted arrays into one array
                const temp = [];
                for (var ix = 0; ix < departures.length; ix++) {
                    if (departures[ix] !== undefined) {
                        for (let iy = 0; iy < departures[ix].length; iy++) {
                            temp.push(departures[ix][iy]);
                        }
                    }
                }

                // TODO:Handle resp.ResponseData.StopPointDeviations
                CurrentDepartures.departures = temp;
                log('Found ' + CurrentDepartures.departures.length + ' DEPARTURES for station id=' + station.stationId);
                resolve(CurrentDepartures);
            })
            .catch(function (err) {
                log('Problems: station id=' + station.stationId + ' ' + err);
                reject({resp: {StatusCode: 600, Message: err}});
            });
    },

    // --------------------------------------- Add departures to our departures array
    addDepartures: function (station, departures, depArray) {
        for (let ix = 0; ix < depArray.length; ix++) {
            const element = depArray[ix];
            let dep = new Departure(element);
            //debug("BLine: " + dep.LineNumber);
            dep = this.fixJourneyDirection(station, dep);

            if (!this.shouldLineBeVisible(station, dep) || !this.isWantedDirection(dep.JourneyDirection)) {
                continue;
            }

            debug("Adding Line: " + dep.LineNumber + " Dir:" + dep.JourneyDirection + " Dst:" + dep.Destination);
            if (departures[dep.JourneyDirection] === undefined) {
                departures[dep.JourneyDirection] = [];
            }
            departures[dep.JourneyDirection].push(dep);
        }
    },

    // --------------------------------------- Are we asking for this direction
    isWantedDirection: function (dir) {
        if (this.config.direction !== undefined && this.config.direction !== '') {
            return dir === this.config.direction;
        }
        return true;
    },

    // --------------------------------------- If we want to change direction number on a line
    fixJourneyDirection: function (station, dep) {
        const swapper = [0, 2, 1];
        if (station.lines === undefined || !Array.isArray(station.lines)) {
            return dep;
        }

        for (let lineIndex = 0; lineIndex < station.lines.length; lineIndex++) { // Check if this is a line we have defined
            if (dep.LineNumber !== station.lines[lineIndex].line) {
                continue;
            }

            debug("Checking direction for line " + dep.LineNumber + " Dir: " + dep.JourneyDirection);
            if (station.lines[lineIndex].swapDir !== undefined && station.lines[lineIndex].swapDir) {
                const newdir = swapper[dep.JourneyDirection];
                debug("Swapping direction for line " + dep.LineNumber + " From: " + dep.JourneyDirection + " To: " + newdir);
                dep.JourneyDirection = newdir;
            }
        }

        return dep;
    },

    // --------------------------------------- Are we asking for this line in this direction
    shouldLineBeVisible: function (station, dep) {
        if (station.lines === undefined) {
            return true; // Take all lines on this station
        }

        if (!Array.isArray(station.lines)) {
            log('Problems: station id=' + station.stationId + ' lines is defined but not as array.');
            throw new Error('station id=' + station.stationId + ' lines is defined but not as array.')
        }

        for (let lineIndex = 0; lineIndex < station.lines.length; lineIndex++) { // Check if this is a line we want
            if (dep.LineNumber === station.lines[lineIndex].line) {
                debug("Checking line " + dep.LineNumber + " Dir: " + dep.JourneyDirection);
                if (station.lines[lineIndex].direction !== undefined) {
                    return dep.JourneyDirection === station.lines[lineIndex].direction;
                } else {
                    return true; // We take all directions for this line
                }
            }
        }
        return false;
    },

    // --------------------------------------- Figure out the next update time
    getNextUpdateInterval: function () {
        if (this.config.highUpdateInterval === undefined) {
            return this.config.updateInterval;
        }

        // TODO: dont throw here use the normal update time but log the errors
        if (this.config.highUpdateInterval.times === undefined) {
            log("ERROR: highUpdateInterval.times is undefined in configuration.");
            log("ERROR: Please remove the highUpdateInterval parameter if you do not use it.");
            return this.config.updateInterval;
        }

        if (!Array.isArray(this.config.highUpdateInterval.times)) {
            throw new Error("highUpdateInterval.times is not an array");
        }

        //Check which interval we are in and return the proper timer
        for (let i = 0; i < this.config.highUpdateInterval.times.length; i++) {
            const intervalDefinition = this.config.highUpdateInterval.times[i];
            if (this.isBetween(intervalDefinition.days, intervalDefinition.start, intervalDefinition.stop)) {
                if (intervalDefinition.interval !== undefined) {
                    // If the interval has it's own update frequency defined, use that
                    return intervalDefinition.interval
                }
                // If the interval doesn't have it own update frequency defined, use the high interval frequency.
                return this.config.highUpdateInterval.updateInterval
            }
        }
        return this.config.updateInterval;
    },

    // --------------------------------------- Check if now is in this time
    isBetween: function (days, start, stop) {
        const now = new Date();
        const dow = now.getDay();
        switch (days) {
            case 'weekdays':
                if (0 < dow && dow < 6) {
                    return this.isTimeBetween(start, stop);
                }
                break;
            case 'weekends':
                if (0 === dow || dow === 6) {
                    return this.isTimeBetween(start, stop);
                }
                break;
        }
        return false;
    },

    // --------------------------------------- Check if now is between these times
    isTimeBetween: function (start, stop) {
        const now = new Date();
        let startDate = stringToDate(start);
        let stopDate = stringToDate(stop);
        return (now > startDate && now < stopDate) || (now < startDate && now > stopDate);
    },

    // --------------------------------------- Handle notifications
    socketNotificationReceived: function (notification, payload) {
        const self = this;
        if (notification === 'CONFIG' /*&& this.started == false*/) {
            this.config = payload;
            this.started = true;
            debugModeEnabled = this.config.debug;
            self.scheduleUpdate();
            self.getDepartures(); // Get it first time
        }
    }
});

//
// Utilities
//
function dynamicSort(property) {
    let sortOrder = 1;
    if (property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a, b) {
        const result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
}

// --------------------------------------- Create a date object with the time in timeStr (hh:mm)
function stringToDate(timeStr) {
    const parts = timeStr.split(':');
    const date = new Date();
    date.setHours(+parts.shift());
    date.setMinutes(+parts.shift());
    return date;
}

// --------------------------------------- At beginning of log entries
function logStart() {
    return (new Date(Date.now())).toLocaleTimeString() + " MMM-SL-PublicTransport: ";
}

// --------------------------------------- Logging
function log(msg) {
    console.log(logStart() + msg);
}

// --------------------------------------- Debugging
function debug(msg) {
    if (debugModeEnabled) {
        log(msg);
    }
}
