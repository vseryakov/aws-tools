# AWS tools

## ebs-migrate

This command migrates an EBS volume from one running instance to another instance, the primary
use case to reuse existing server on different instance type without snapshots.

The basic schenario is the following:

- at the beginning, launch empty instance using any EBS AMI, let's say Amazon AMI 2014.03.1, ami-8b8d91e2, t1.micro
- setup the system, install the software, run ....
- later there is a need to re-launch this server on different instance type, let's say m1.large
- find the instance id and run the command `node ebs-migrate.js -instance id -type m1.large`
- repeat the procedure every time this instance needs to be run on other virtual hardware

In case of error the utility stops and leave the old instance and the EBS volume as it is. No automatic recovery
is performed, there could be many reasons for a failure and it is not possible to cover all of them, manual
inspection will be needed fro the reason of failure.

The migration will transfer all tags, Elastic IP, keys to the new instance, will run in the same 
region, subnet, availability zone and with the same security groups.

Installation:

This script requires node.js installed with the following packages: async, aws2js

To install:

	npm install async aws2js

To run the script:

	node ebs-migrate -instance id -type type ...

Command line parameters:

- help - show usage help
- show - retrieve the instance info and show it, no any other action is taked, for the inspection before launching
- debug - show all input and output on the console
- instance id - AWS instance id, if not specified all instances will be shown only
- type type - new instance type, default is m1.large
- timeout ms - how long to wait for any status, insyance or volume, default is 5 mins
- region r - region where to login
- key k - AWS access key, if not given env variable AWS_ACCESS_KEY_ID is used
- secret s - AWS access secret, if not given env variable AWS_SECRET_ACCESS_KEY is used
- device d - device to use for migration, default is /dev/sda1

# Author
Vlad Seryakov

